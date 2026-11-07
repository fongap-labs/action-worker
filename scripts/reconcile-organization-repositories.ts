import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseRepositoryPolicy, type RepositoryCapability } from "./repository-policy.ts";

type OnboardingPolicy = {
  schema_version: 1;
  organization: string;
  auto_enroll_created_after: string;
  excluded_repositories: string[];
  grants: Record<string, RepositoryCapability[]>;
};

type InstalledRepository = {
  full_name: string;
  owner: { login: string };
  default_branch: string;
  created_at: string;
  archived: boolean;
  disabled?: boolean;
};

const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function parseOnboardingPolicy(value: unknown): OnboardingPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Onboarding policy must be an object.");
  }
  const policy = value as OnboardingPolicy;
  if (
    policy.schema_version !== 1 ||
    typeof policy.organization !== "string" ||
    !/^[A-Za-z0-9_.-]+$/.test(policy.organization) ||
    typeof policy.auto_enroll_created_after !== "string" ||
    !Number.isFinite(Date.parse(policy.auto_enroll_created_after)) ||
    !Array.isArray(policy.excluded_repositories) ||
    !policy.excluded_repositories.every(
      (x) => typeof x === "string" && repositoryPattern.test(x)
    ) ||
    new Set(policy.excluded_repositories).size !== policy.excluded_repositories.length
  ) {
    throw new Error("Invalid onboarding policy.");
  }
  // Validate all explicit privileges with the same contract as central intake.
  parseRepositoryPolicy(policy.grants);
  for (const name of [...Object.keys(policy.grants), ...policy.excluded_repositories]) {
    if (name.split("/")[0]?.toLowerCase() !== policy.organization.toLowerCase()) {
      throw new Error("Managed repository grant is outside the configured organization.");
    }
  }
  for (const excluded of policy.excluded_repositories) {
    if (Object.hasOwn(policy.grants, excluded)) {
      throw new Error("An excluded repository must not have explicit grants.");
    }
  }
  return policy;
}

export function reconcileRepositoryPolicy(
  source: unknown,
  installedRepositories: readonly InstalledRepository[]
): Record<string, RepositoryCapability[]> {
  const policy = parseOnboardingPolicy(source);
  const excluded = new Set(policy.excluded_repositories);
  const seen = new Set<string>();
  const result: Record<string, RepositoryCapability[]> = {};
  for (const repo of installedRepositories) {
    if (
      !repo ||
      !repositoryPattern.test(repo.full_name) ||
      repo.owner?.login?.toLowerCase() !== policy.organization.toLowerCase() ||
      repo.full_name.split("/")[0]?.toLowerCase() !== policy.organization.toLowerCase()
    ) {
      throw new Error("Installation returned an invalid or cross-organization repository.");
    }
    if (seen.has(repo.full_name))
      throw new Error("Duplicate repository in installation inventory.");
    seen.add(repo.full_name);
    if (repo.archived || repo.disabled || excluded.has(repo.full_name)) continue;
    if (repo.default_branch !== "main") continue;
    const grants = policy.grants[repo.full_name];
    if (grants) {
      result[repo.full_name] = [...grants];
      continue;
    }
    // Historic repositories are not silently brought under a new gate.
    // From the cutover onward, new repos start with PR/CI governance only.
    if (
      typeof repo.created_at === "string" &&
      Number.isFinite(Date.parse(repo.created_at)) &&
      Date.parse(repo.created_at) >= Date.parse(policy.auto_enroll_created_after)
    ) {
      result[repo.full_name] = ["pr"];
    }
  }
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)));
}

function githubApi(token: string, endpoint: string, method = "GET", body?: unknown): unknown {
  const args = ["api", "--method", method, endpoint];
  if (body !== undefined) args.push("--input", "-");
  const stdout = execFileSync("gh", args, {
    env: { ...process.env, GH_TOKEN: token },
    encoding: "utf8",
    input: body === undefined ? undefined : JSON.stringify(body),
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  });
  return stdout.trim() ? (JSON.parse(stdout) as unknown) : {};
}

function installedInventory(token: string): InstalledRepository[] {
  const result: InstalledRepository[] = [];
  for (let page = 1; page <= 100; page++) {
    const response = githubApi(token, `installation/repositories?per_page=100&page=${page}`);
    const repos = (response as { repositories?: unknown }).repositories;
    if (!Array.isArray(repos)) throw new Error("Invalid installation inventory response.");
    result.push(...(repos as InstalledRepository[]));
    if (repos.length < 100) return result;
  }
  throw new Error("Installation inventory exceeds the supported pagination limit.");
}

function main(): void {
  const owner = process.env.GITHUB_REPOSITORY?.split("/")[0] ?? "";
  const control = process.env.GITHUB_REPOSITORY ?? "";
  const appToken = process.env.AW_INVENTORY_APP_TOKEN ?? "";
  const adminToken = process.env.AW_ADMIN_TOKEN ?? "";
  const currentRaw = process.env.AW_REPOSITORY_POLICY ?? "";
  if (!repositoryPattern.test(control) || !appToken || !adminToken || !currentRaw) {
    throw new Error(
      "Control repository and inventory, admin and current-policy credentials are required."
    );
  }
  const source = JSON.parse(
    readFileSync("policies/organization-onboarding.json", "utf8")
  ) as unknown;
  const sourcePolicy = parseOnboardingPolicy(source);
  assert.equal(owner.toLowerCase(), sourcePolicy.organization.toLowerCase());
  const next = reconcileRepositoryPolicy(source, installedInventory(appToken));
  const current = parseRepositoryPolicy(JSON.parse(currentRaw) as unknown);
  // The protected file owns elevated grants. Reject out-of-band capability expansion
  // instead of silently treating an edited GitHub Actions variable as authority.
  for (const [repo, capabilities] of Object.entries(current)) {
    if (Object.hasOwn(next, repo) && Object.hasOwn(sourcePolicy.grants, repo)) {
      const expected = [...(sourcePolicy.grants[repo] ?? [])].sort();
      const actual = [...capabilities].sort();
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(
          "Elevated repository grants differ from the versioned policy; reconcile by PR."
        );
      }
    }
  }
  if (
    JSON.stringify(Object.entries(current).sort()) === JSON.stringify(Object.entries(next).sort())
  ) {
    console.log(
      `Repository inventory already current: ${Object.keys(next).length} managed repositories.`
    );
    return;
  }
  if (Object.keys(next).length === 0)
    throw new Error("Empty inventory cannot replace repository policy.");
  const value = JSON.stringify(next);
  githubApi(adminToken, `repos/${control}/actions/variables/AW_REPOSITORY_POLICY`, "PATCH", {
    name: "AW_REPOSITORY_POLICY",
    value,
  });
  console.log(
    `Repository inventory reconciled: ${Object.keys(next).length} managed repositories; no secret values logged.`
  );
  // Each dispatcher re-reads the updated repository variable at job start.
  for (const event_type of ["run-intake", "managed-repositories-changed"]) {
    githubApi(adminToken, `repos/${control}/dispatches`, "POST", { event_type });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(
      `::error::Repository onboarding failed: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exitCode = 1;
  }
}
