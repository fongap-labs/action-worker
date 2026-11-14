import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { decodeGithubContent, GithubReader, isGithubMissing, isJsonRecord } from "./github-api.ts";
import { appendLines, CliError, isMain } from "./runtime-command.ts";
import { type InventoryRepo, readInstallationInventory } from "./security-coverage-audit.ts";

const controlRepository = "fongap-labs/action-worker";
const bridgePath = ".github/workflows/notify-action-worker.yml";
const templatePath = "policies/templates/notify-action-worker.yml";
const branchName = "automation/central-ci-onboarding";
const repositoryPattern = /^fongap-labs\/[A-Za-z0-9_.-]+$/;

export type BridgeTarget = { repository: string; default_branch: string };

/** All authorized active repositories, regardless of age, are default CI candidates. */
export function selectBridgeCandidates(
  inventory: readonly InventoryRepo[],
  control: string
): BridgeTarget[] {
  if (!repositoryPattern.test(control)) {
    throw new CliError("Central CI control identity is invalid.", 65);
  }
  const seen = new Set<string>();
  const targets: BridgeTarget[] = [];
  for (const item of inventory) {
    if (!repositoryPattern.test(item.full_name) || seen.has(item.full_name)) {
      throw new CliError("Central CI inventory identity is invalid.", 65);
    }
    seen.add(item.full_name);
    if (item.full_name === control || item.archived || item.disabled) continue;
    // The approved bridge listens to main pushes; do not claim non-main coverage.
    if (item.default_branch !== "main") {
      throw new CliError("Central CI inventory has an unsupported default branch.", 77);
    }
    targets.push({ repository: item.full_name, default_branch: item.default_branch });
  }
  return targets.sort((a, b) => a.repository.localeCompare(b.repository));
}

async function hasPendingBridgePullRequest(
  reader: Pick<GithubReader, "get">,
  repository: string
): Promise<boolean> {
  const pulls = await reader.get(
    "repos/" + repository + "/pulls?state=open&base=main&per_page=100"
  );
  if (!Array.isArray(pulls) || pulls.length >= 100) {
    throw new CliError("Central CI pending PR inventory is incomplete.", 77);
  }
  for (const pr of pulls) {
    if (!isJsonRecord(pr) || !Number.isSafeInteger(pr.number)) {
      throw new CliError("Central CI pending PR identity is invalid.", 65);
    }
    const files = await reader.get(
      "repos/" + repository + "/pulls/" + pr.number + "/files?per_page=100"
    );
    if (!Array.isArray(files) || files.length >= 100) {
      throw new CliError("Central CI pending PR file list is incomplete.", 77);
    }
    if (files.some((file) => isJsonRecord(file) && file.filename === bridgePath)) {
      // An existing business PR is not a verified bridge. Avoid duplicate PRs;
      // the coverage audit stays red until the trusted main actually has the file.
      return true;
    }
  }
  return false;
}

async function missingBridges(
  reader: Pick<GithubReader, "get">,
  candidates: readonly BridgeTarget[]
): Promise<{ targets: BridgeTarget[]; pending: number }> {
  const targets: BridgeTarget[] = [];
  let pending = 0;
  for (const candidate of candidates) {
    try {
      const response = await reader.get(
        "repos/" + candidate.repository + "/contents/" + bridgePath + "?ref=main"
      );
      if (!isJsonRecord(response) || response.type !== "file") {
        throw new CliError("Central CI bridge metadata is invalid.", 65);
      }
    } catch (error) {
      if (!isGithubMissing(error)) throw error;
      if (await hasPendingBridgePullRequest(reader, candidate.repository)) pending++;
      else targets.push(candidate);
    }
  }
  return { targets, pending };
}

async function approvedBridgeTemplate(): Promise<string> {
  const content = await readFile(templatePath, "utf8");
  const policy = JSON.parse(await readFile("policies/security.json", "utf8")) as unknown;
  if (!isJsonRecord(policy) || !Array.isArray(policy.approved_workflows)) {
    throw new CliError("Central CI bridge approval policy is invalid.", 65);
  }
  const digest = createHash("sha256").update(content).digest("hex");
  if (
    !policy.approved_workflows.some(
      (entry) => isJsonRecord(entry) && entry.path === bridgePath && entry.sha256 === digest
    )
  ) {
    throw new CliError("Central CI bridge template does not match the approved security hash.", 77);
  }
  return content;
}

async function writeGithub(
  token: string,
  path: string,
  method: "POST" | "PUT",
  payload: unknown
): Promise<unknown> {
  const response = await fetch("https://api.github.com/" + path, {
    method,
    headers: {
      Authorization: "Bearer " + token,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    const action = path.includes("/contents/")
      ? "workflow-file"
      : path.includes("/git/refs")
        ? "branch"
        : "pull-request";
    throw new CliError(
      "Central CI " + action + " write rejected (HTTP " + response.status + ").",
      77
    );
  }
  return (await response.json()) as unknown;
}

async function existingOnboarding(
  reader: Pick<GithubReader, "get">,
  target: BridgeTarget,
  template: string
): Promise<boolean> {
  const repository = target.repository;
  const query = encodeURIComponent("fongap-labs:" + branchName);
  const response = await reader.get(
    "repos/" + repository + "/pulls?state=open&head=" + query + "&base=main&per_page=100"
  );
  if (!Array.isArray(response) || response.length > 1) {
    throw new CliError("Central CI onboarding pull request inventory is ambiguous.", 77);
  }
  if (response.length === 0) return false;
  const pr = response[0];
  if (!isJsonRecord(pr) || !Number.isSafeInteger(pr.number) || !isJsonRecord(pr.head)) {
    throw new CliError("Central CI onboarding pull request metadata is invalid.", 65);
  }
  const head = pr.head;
  const headRepo = head.repo;
  if (
    head.ref !== branchName ||
    typeof head.sha !== "string" ||
    !/^[a-f0-9]{40}$/.test(head.sha) ||
    !isJsonRecord(headRepo) ||
    headRepo.full_name !== repository
  ) {
    throw new CliError("Central CI onboarding pull request head is untrusted.", 77);
  }
  const changed = await reader.get(
    "repos/" + repository + "/pulls/" + pr.number + "/files?per_page=100"
  );
  if (
    !Array.isArray(changed) ||
    changed.length !== 1 ||
    !isJsonRecord(changed[0]) ||
    changed[0].filename !== bridgePath ||
    changed[0].status !== "added"
  ) {
    throw new CliError("Central CI onboarding pull request changed unexpected files.", 77);
  }
  const file = await reader.get(
    "repos/" + repository + "/contents/" + bridgePath + "?ref=" + head.sha
  );
  if (decodeGithubContent(file) !== template) {
    throw new CliError("Central CI onboarding pull request content is untrusted.", 77);
  }
  return true;
}

async function createBridgePullRequest(
  reader: Pick<GithubReader, "get">,
  writeToken: string,
  target: BridgeTarget,
  template: string
): Promise<boolean> {
  if (await existingOnboarding(reader, target, template)) return false;
  const repository = target.repository;
  const ref = (await reader.get(
    "repos/" + repository + "/git/ref/heads/" + target.default_branch
  )) as unknown;
  if (
    !isJsonRecord(ref) ||
    !isJsonRecord(ref.object) ||
    typeof ref.object.sha !== "string" ||
    !/^[a-f0-9]{40}$/.test(ref.object.sha)
  ) {
    throw new CliError("Central CI target default branch cannot be verified.", 77);
  }

  // Resume only a previously created empty branch at the exact current main SHA.
  // Never overwrite a branch containing edits, and never force-push.
  let hasExistingBranch = false;
  try {
    const existing = await reader.get("repos/" + repository + "/git/ref/heads/" + branchName);
    if (
      !isJsonRecord(existing) ||
      !isJsonRecord(existing.object) ||
      existing.object.sha !== ref.object.sha
    ) {
      throw new CliError("Central CI onboarding branch contains unverified work.", 77);
    }
    hasExistingBranch = true;
  } catch (error) {
    if (!isGithubMissing(error)) throw error;
  }
  if (!hasExistingBranch) {
    await writeGithub(writeToken, "repos/" + repository + "/git/refs", "POST", {
      ref: "refs/heads/" + branchName,
      sha: ref.object.sha,
    });
  }
  await writeGithub(writeToken, "repos/" + repository + "/contents/" + bridgePath, "PUT", {
    message: "chore: add approved central CI notification bridge",
    branch: branchName,
    content: Buffer.from(template, "utf8").toString("base64"),
  });
  const result = await writeGithub(writeToken, "repos/" + repository + "/pulls", "POST", {
    title: "chore: 接入中央 CI 安全门禁",
    head: branchName,
    base: target.default_branch,
    body: [
      "由 Action Worker 已授权仓库清单自动发现缺失的中央 CI 通知桥接。",
      "本 PR 仅添加经过安全哈希批准的固定工作流，不修改业务源码、凭据、Ruleset 或合并规则。",
      "须经原有中央 CI 和 GitHub Ruleset 验证，严禁绕过门禁。",
    ].join("\n"),
  });
  if (!isJsonRecord(result) || !Number.isSafeInteger(result.number)) {
    throw new CliError("Central CI onboarding pull request was not confirmed.", 77);
  }
  return true;
}

async function main(): Promise<void> {
  const mode = process.argv[2] ?? "";
  const token = process.env.AW_INVENTORY_TOKEN ?? "";
  if (
    process.env.GITHUB_REPOSITORY !== controlRepository ||
    process.env.GITHUB_REF !== "refs/heads/main" ||
    !token ||
    !["plan", "apply"].includes(mode)
  ) {
    throw new CliError("Central CI enrollment requires trusted main and a read token.", 77);
  }
  const reader = new GithubReader(process.env.GITHUB_API_URL ?? "https://api.github.com", token);
  const inventory = await readInstallationInventory(reader);
  const candidates = selectBridgeCandidates(inventory, controlRepository);
  const { targets: missing, pending } = await missingBridges(reader, candidates);
  if (missing.length > 500) {
    throw new CliError("Central CI write token scope exceeds the safe batch limit.", 77);
  }
  if (mode === "plan") {
    await approvedBridgeTemplate();
    for (const item of missing) {
      // Mask dynamic repository names before the token action displays scoped inputs.
      console.log("::add-mask::" + item.repository.split("/")[1]);
    }
    await appendLines(process.env.GITHUB_OUTPUT, [
      "has_targets=" + String(missing.length > 0),
      "repositories_csv=" + missing.map((item) => item.repository.split("/")[1]).join(","),
      "targets_json=" + JSON.stringify(missing),
    ]);
    console.log(
      "Central CI discovery: " +
        inventory.length +
        " accessible, " +
        missing.length +
        " bridge PR candidates, " +
        pending +
        " existing bridge PRs pending; identities withheld."
    );
    return;
  }
  const writer = process.env.AW_CI_WRITE_TOKEN ?? "";
  let selected: unknown;
  try {
    selected = JSON.parse(process.env.AW_CI_TARGETS_JSON ?? "");
  } catch {
    throw new CliError("Central CI scoped target list is invalid.", 65);
  }
  if (
    !writer ||
    !Array.isArray(selected) ||
    JSON.stringify(selected) !== JSON.stringify(missing) ||
    missing.length === 0
  ) {
    throw new CliError("Central CI bridge write scope changed or was not authorized.", 77);
  }
  const template = await approvedBridgeTemplate();
  let created = 0;
  let alreadyPending = 0;
  for (const target of missing) {
    if (await createBridgePullRequest(reader, writer, target, template)) created++;
    else alreadyPending++;
  }
  console.log(
    "Central CI bridge enrollment: " +
      created +
      " PRs created, " +
      alreadyPending +
      " approved PRs pending; repository identities withheld."
  );
}

if (isMain(import.meta.url)) {
  main().catch((error: unknown) => {
    const reason = error instanceof CliError ? error.message : "unverified operation";
    console.error(
      "::error::Central CI enrollment failed: " + reason + "; repository details withheld."
    );
    process.exitCode = 1;
  });
}
