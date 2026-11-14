import { readFileSync } from "node:fs";
import { parseRepositoryPolicy } from "./repository-policy.ts";
import { isMain } from "./runtime-command.ts";

export type InstalledRepo = {
  full_name: string;
  owner: { login: string };
  default_branch: string;
  created_at: string;
  archived: boolean;
  disabled?: boolean;
  fork?: boolean;
};

export type AccessPolicy = {
  schema_version: number;
  organization: string;
  auto_enroll_created_after: string;
  excluded_repositories: string[];
  grants: Record<string, string[]>;
};

const repoPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const controlRepo = "fongap-labs/action-worker";
const policyPath = "policies/repository-access.json";
const branchName = "automation/organization-onboarding";

function asPolicy(value: unknown): AccessPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Repository access policy is not an object.");
  }
  const policy = value as AccessPolicy;
  if (
    policy.schema_version !== 1 ||
    policy.organization !== "fongap-labs" ||
    !Number.isFinite(Date.parse(policy.auto_enroll_created_after)) ||
    !Array.isArray(policy.excluded_repositories) ||
    !policy.excluded_repositories.every(
      (name) => typeof name === "string" && repoPattern.test(name)
    ) ||
    typeof policy.grants !== "object" ||
    policy.grants === null ||
    Array.isArray(policy.grants)
  ) {
    throw new Error("Repository access policy is invalid.");
  }
  parseRepositoryPolicy(policy.grants);
  for (const excluded of policy.excluded_repositories) {
    if (Object.hasOwn(policy.grants, excluded)) {
      throw new Error(`Excluded repository must not retain a governance grant: ${excluded}`);
    }
  }
  if (Object.keys(policy.grants).some((name) => !name.startsWith("fongap-labs/"))) {
    throw new Error("Cross-organization grant is forbidden.");
  }
  return policy;
}

export function planOnboarding(value: unknown, installed: readonly InstalledRepo[]): AccessPolicy {
  const policy = asPolicy(value);
  const grants: Record<string, string[]> = { ...policy.grants };
  const excluded = new Set(policy.excluded_repositories);
  const found = new Set<string>();
  for (const repo of installed) {
    if (
      !repoPattern.test(repo.full_name) ||
      repo.owner?.login !== policy.organization ||
      !repo.full_name.startsWith(`${policy.organization}/`)
    ) {
      throw new Error("Invalid or cross-organization installation inventory.");
    }
    if (found.has(repo.full_name)) throw new Error("Duplicate installed repository.");
    found.add(repo.full_name);
    if (
      grants[repo.full_name] ||
      excluded.has(repo.full_name) ||
      repo.archived ||
      repo.disabled ||
      repo.fork ||
      repo.default_branch !== "main"
    ) {
      continue;
    }
    // Default onboarding applies to existing and newly installed active main-branch repositories.
    // The legacy creation-date field is retained for policy compatibility, not as a gate.
    grants[repo.full_name] = ["pr"];
  }
  return {
    ...policy,
    grants: Object.fromEntries(Object.entries(grants).sort(([a], [b]) => a.localeCompare(b))),
  };
}

export function safeOnboardingOnly(
  initial: unknown,
  candidate: unknown,
  installed: readonly InstalledRepo[]
): boolean {
  const before = asPolicy(initial);
  const after = asPolicy(candidate);
  if (
    before.schema_version !== after.schema_version ||
    before.organization !== after.organization ||
    before.auto_enroll_created_after !== after.auto_enroll_created_after ||
    JSON.stringify(before.excluded_repositories) !== JSON.stringify(after.excluded_repositories)
  ) {
    return false;
  }
  const allowed = planOnboarding(before, installed);
  for (const [repo, grants] of Object.entries(before.grants)) {
    if (JSON.stringify(after.grants[repo]) !== JSON.stringify(grants)) return false;
  }
  if (Object.keys(after.grants).length <= Object.keys(before.grants).length) return false;
  return Object.entries(after.grants).every(
    ([repo, grants]) =>
      Object.hasOwn(before.grants, repo) ||
      (JSON.stringify(grants) === JSON.stringify(["pr"]) && Object.hasOwn(allowed.grants, repo))
  );
}

type GithubResponse = Record<string, unknown>;
async function github(
  token: string,
  path: string,
  method = "GET",
  body?: unknown
): Promise<unknown> {
  const response = await fetch(`https://api.github.com/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`GitHub API ${method} returned HTTP ${response.status}.`);
  if (response.status === 204) return {};
  return (await response.json()) as unknown;
}

async function installationRepos(token: string): Promise<InstalledRepo[]> {
  const repos: InstalledRepo[] = [];
  for (let page = 1; page <= 100; page += 1) {
    const body = (await github(token, `installation/repositories?per_page=100&page=${page}`)) as {
      repositories?: InstalledRepo[];
    };
    if (!Array.isArray(body.repositories)) throw new Error("Invalid App repository inventory.");
    repos.push(...body.repositories);
    if (body.repositories.length < 100) return repos;
  }
  throw new Error("GitHub App inventory exceeds the 10,000-repository scan limit.");
}

async function readFile(token: string, ref: string): Promise<{ value: AccessPolicy; sha: string }> {
  const path = `repos/${controlRepo}/contents/${policyPath}?ref=${encodeURIComponent(ref)}`;
  const result = (await github(token, path)) as {
    content?: string;
    sha?: string;
    encoding?: string;
  };
  if (result.encoding !== "base64" || !result.content || !result.sha) {
    throw new Error("Unexpected policy file response.");
  }
  const decoded = Buffer.from(result.content.replace(/\s/g, ""), "base64").toString("utf8");
  return { value: asPolicy(JSON.parse(decoded) as unknown), sha: result.sha };
}

async function mergeExisting(
  readToken: string,
  writeToken: string,
  inventory: readonly InstalledRepo[],
  base: AccessPolicy,
  pr: GithubResponse
): Promise<void> {
  const number = pr.number;
  const head = pr.head as GithubResponse | undefined;
  const target = pr.base as GithubResponse | undefined;
  const currentSha = head?.sha;
  const headRepo = head?.repo as GithubResponse | undefined;
  if (
    !Number.isInteger(number) ||
    typeof currentSha !== "string" ||
    !/^[0-9a-f]{40}$/.test(currentSha) ||
    head?.ref !== branchName ||
    headRepo?.full_name !== controlRepo ||
    target?.ref !== "main"
  ) {
    throw new Error("Untrusted auto-enrollment PR metadata.");
  }
  const files = (await github(
    readToken,
    `repos/${controlRepo}/pulls/${number}/files?per_page=100`
  )) as Array<{
    filename: string;
    status: string;
  }>;
  if (!Array.isArray(files) || files.length !== 1 || files[0]?.filename !== policyPath) {
    throw new Error("Automatic enrollment PR changes files outside the policy.");
  }
  const candidate = await readFile(readToken, currentSha);
  if (!safeOnboardingOnly(base, candidate.value, inventory)) {
    throw new Error("Automatic enrollment PR does not contain only permitted basic PR grants.");
  }
  const checks = (await github(
    readToken,
    `repos/${controlRepo}/commits/${currentSha}/check-runs?check_name=validate-merge&per_page=100`
  )) as {
    check_runs?: Array<{
      name: string;
      status: string;
      conclusion?: string;
      app?: { id?: number };
      head_sha?: string;
    }>;
  };
  if (!Array.isArray(checks.check_runs)) throw new Error("Invalid CI gate response.");
  if (
    !checks.check_runs.some(
      (check) =>
        check.name === "validate-merge" &&
        check.status === "completed" &&
        check.conclusion === "success" &&
        check.app?.id === 15368 &&
        check.head_sha === currentSha
    )
  ) {
    console.log(`Enrollment PR #${number} awaits a successful original validate-merge check.`);
    return;
  }
  // GitHub Ruleset remains the authority. Do not retry a blocked merge by bypassing it.
  const result = (await github(writeToken, `repos/${controlRepo}/pulls/${number}/merge`, "PUT", {
    sha: currentSha,
    merge_method: "squash",
  })) as { merged?: boolean };
  if (result.merged !== true) throw new Error("GitHub did not confirm the enrollment merge.");
  console.log(`Merged verified repository enrollment PR #${number}.`);
}

async function main(): Promise<void> {
  const inventoryToken = process.env.AW_INVENTORY_TOKEN ?? "";
  const writeToken = process.env.AW_REPOSITORY_WRITE_TOKEN ?? "";
  const readToken = process.env.GITHUB_TOKEN ?? "";
  if (
    process.env.GITHUB_REPOSITORY !== controlRepo ||
    process.env.GITHUB_REF !== "refs/heads/main" ||
    !inventoryToken ||
    !writeToken ||
    !readToken
  ) {
    throw new Error("Only trusted Action Worker main may reconcile the organization.");
  }
  const base = asPolicy(JSON.parse(readFileSync(policyPath, "utf8")) as unknown);
  const inventory = await installationRepos(inventoryToken);
  const pulls = (await github(
    readToken,
    `repos/${controlRepo}/pulls?state=open&head=fongap-labs:${encodeURIComponent(branchName)}&per_page=100`
  )) as GithubResponse[];
  if (!Array.isArray(pulls)) throw new Error("Invalid open PR response.");
  if (pulls.length > 1) throw new Error("Multiple active auto-enrollment PRs.");
  if (pulls.length === 1) {
    await mergeExisting(readToken, writeToken, inventory, base, pulls[0]!);
    return;
  }

  const next = planOnboarding(base, inventory);
  const additions = Object.keys(next.grants).filter((name) => !Object.hasOwn(base.grants, name));
  if (additions.length === 0) {
    console.log(
      `Inventory reconciled: ${inventory.length} accessible repositories; no new grants.`
    );
    return;
  }

  const mainHead = (await github(readToken, `repos/${controlRepo}/git/ref/heads/main`)) as {
    object?: { sha?: string };
  };
  if (!/^[0-9a-f]{40}$/.test(mainHead.object?.sha ?? "")) {
    throw new Error("Cannot resolve trusted control main SHA.");
  }
  await github(writeToken, `repos/${controlRepo}/git/refs`, "POST", {
    ref: `refs/heads/${branchName}`,
    sha: mainHead.object!.sha,
  });
  const current = await readFile(readToken, "main");
  if (JSON.stringify(current.value) !== JSON.stringify(base)) {
    throw new Error("Control policy changed since checkout; refusing stale enrollment.");
  }
  const content = `${JSON.stringify(next, null, 2)}\n`;
  await github(writeToken, `repos/${controlRepo}/contents/${policyPath}`, "PUT", {
    message: "chore(governance): automatically enroll new repositories for PR checks",
    branch: branchName,
    sha: current.sha,
    content: Buffer.from(content, "utf8").toString("base64"),
  });
  const pr = (await github(writeToken, `repos/${controlRepo}/pulls`, "POST", {
    title: "chore(governance): auto-enroll new organization repositories",
    head: branchName,
    base: "main",
    body: [
      "GitHub App inventory discovered these new main-branch repositories:",
      ...additions.map((name) => `- \`${name}\`: \`pr\` only`),
      "",
      "No task, release, deploy, secrets or bypass permissions are granted.",
      "This change is restricted to the canonical policy and must pass the existing validate-merge before merge.",
    ].join("\n"),
  })) as { number?: number };
  if (!Number.isInteger(pr.number)) throw new Error("GitHub did not confirm the enrollment PR.");
  console.log(`Opened auto-enrollment PR #${pr.number} for ${additions.length} new repositories.`);
}

if (isMain(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(
      `::error::Organization enrollment failed: ${error instanceof Error ? error.message : "Unknown error"}`
    );
    process.exitCode = 1;
  });
}
