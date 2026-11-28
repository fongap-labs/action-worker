import { readFile } from "node:fs/promises";
import { isDevEnabled, readBranchPolicy } from "./branch-publication-policy.ts";
import {
  decodeGithubContent,
  GithubReader,
  getGithubJsonIfExists,
  getJsonString,
  isJsonRecord,
} from "./github-api.ts";
import { hasRepositoryCapability, readRepositoryPolicyText } from "./repository-policy.ts";
import {
  appendLines,
  CliError,
  handleError,
  isMain,
  runCommand,
  runText,
} from "./runtime-command.ts";
import { type InventoryRepo, readInstallationInventory } from "./security-coverage-audit.ts";

const commonHeading = "## Common rules\n";
const branchHeading = "## Branch rules\n";
const repositoryHeading = "## Repository rules\n";
const repositoryPattern = /^fongap-labs\/[A-Za-z0-9_.-]+$/;
const shaPattern = /^[a-f0-9]{40}$/;

export function commonAgentRules(guide: string): string {
  const normalized = guide.replace(/\r\n/g, "\n");
  const common = normalized.indexOf(commonHeading);
  const repository = normalized.indexOf(repositoryHeading);
  if (
    common < 0 ||
    repository <= common ||
    normalized.indexOf(commonHeading, common + commonHeading.length) >= 0 ||
    normalized.indexOf(repositoryHeading, repository + repositoryHeading.length) >= 0
  ) {
    throw new CliError("Central agent guide sections are invalid.", 65);
  }
  const rules = normalized.slice(common + commonHeading.length, repository).trim();
  if (!rules) throw new CliError("Central common agent rules are empty.", 65);
  return rules;
}

export function repositoryAgentRules(guide: string): string | undefined {
  const normalized = guide.replace(/\r\n/g, "\n");
  const common = normalized.indexOf(commonHeading);
  const branch = normalized.indexOf(branchHeading);
  const repository = normalized.indexOf(repositoryHeading);
  if (
    !normalized.startsWith("# AGENTS\n") ||
    common < 0 ||
    branch <= common ||
    repository <= branch ||
    normalized.indexOf(repositoryHeading, repository + repositoryHeading.length) >= 0
  ) {
    return undefined;
  }
  return normalized.slice(repository + repositoryHeading.length).trim() || undefined;
}

export function renderAgentGuide(
  centralGuide: string,
  repository: string,
  projectRules: string,
  policy: unknown
): string {
  if (!repositoryPattern.test(repository) || !projectRules.trim()) {
    throw new CliError("Repository identity and explicit project rules are required.", 65);
  }
  const branchRules = isDevEnabled(policy, repository)
    ? "main is stable/production; dev is Beta only. When dev exists, use dev task branches and PRs only; promote to main solely by authorized dev-to-main PR transfer."
    : "Dev is disabled; use main PRs only when dev is absent. If dev exists, stop for maintainer resolution; do not initialize, target, publish or deploy from dev.";
  return (
    [
      "# AGENTS",
      commonHeading + "\n" + commonAgentRules(centralGuide),
      branchHeading + "\n- " + branchRules,
      repositoryHeading + "\n" + projectRules.trim(),
      "",
    ]
      .join("\n\n")
      .trimEnd() + "\n"
  );
}

export function assertGeneratedAgentGuide(
  guide: string,
  centralGuide: string,
  repository: string,
  policy: unknown
): void {
  const rules = repositoryAgentRules(guide);
  if (
    rules === undefined ||
    /^## (Common|Branch|Repository) rules\s*$/m.test(rules) ||
    guide !== renderAgentGuide(centralGuide, repository, rules, policy)
  ) {
    throw new CliError("AGENTS.md must preserve generated central and branch rules.", 65);
  }
}

export async function validateAgentGuideChange(
  repository: string,
  base: string,
  head: string,
  root: string,
  centralGuide: string,
  policy: unknown
): Promise<void> {
  if (!repositoryPattern.test(repository) || !shaPattern.test(base) || !shaPattern.test(head)) {
    throw new CliError("Invalid agent guide change identity.", 65);
  }
  if (repository === "fongap-labs/action-worker") return;
  const changed = await runText(
    "git",
    [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-renames",
      "--name-only",
      base,
      head,
      "--",
      "AGENTS.md",
    ],
    { cwd: root }
  );
  if (!changed) return;
  const entry = await runText("git", ["ls-tree", head, "--", "AGENTS.md"], { cwd: root });
  if (!/^100644 blob [a-f0-9]{40}\tAGENTS\.md$/.test(entry)) {
    throw new CliError("AGENTS.md must remain a regular tracked file.", 65);
  }
  const guide = (await runCommand("git", ["show", head + ":AGENTS.md"], { cwd: root })).toString(
    "utf8"
  );
  assertGeneratedAgentGuide(guide, centralGuide, repository, policy);
}

type AuditState = "current" | "drifted" | "migration" | "missing" | "absent" | "incomplete";

export async function auditAgentGuides(
  reader: Pick<GithubReader, "get">,
  inventory: readonly InventoryRepo[],
  controlRepository: string,
  centralGuide: string,
  branchPolicy: unknown,
  accessPolicy: unknown
): Promise<Record<AuditState, number>> {
  const counts = { current: 0, drifted: 0, migration: 0, missing: 0, absent: 0, incomplete: 0 };
  for (const item of inventory) {
    const repository = item.full_name;
    if (
      item.archived ||
      item.disabled ||
      repository === controlRepository ||
      !repositoryPattern.test(repository) ||
      !hasRepositoryCapability(repository, accessPolicy, "pr")
    ) {
      continue;
    }
    if (item.default_branch !== "main") {
      counts.incomplete++;
      continue;
    }
    for (const branch of ["main", "dev"]) {
      if (branch === "dev" && !isDevEnabled(branchPolicy, repository)) continue;
      let state: AuditState = "incomplete";
      try {
        const prefix = "repos/" + repository;
        const path = prefix + "/branches/" + branch;
        const snapshot = await getGithubJsonIfExists(path, (key) => reader.get(key));
        if (snapshot === undefined && branch === "dev") {
          counts.absent++;
          continue;
        }
        const sha = isJsonRecord(snapshot) ? getJsonString(snapshot.commit, "sha") : "";
        if (!shaPattern.test(sha)) throw new Error("Invalid branch identity.");
        const tree = await reader.get(prefix + "/git/trees/" + sha);
        if (!isJsonRecord(tree) || tree.truncated !== false || !Array.isArray(tree.tree)) {
          throw new Error("Incomplete root tree.");
        }
        const entry = tree.tree.find((value) => isJsonRecord(value) && value.path === "AGENTS.md");
        if (entry === undefined) {
          state = "missing";
        } else {
          if (
            !isJsonRecord(entry) ||
            entry.type !== "blob" ||
            entry.mode !== "100644" ||
            typeof entry.sha !== "string" ||
            !shaPattern.test(entry.sha)
          ) {
            throw new Error("Invalid agent guide object.");
          }
          const text = decodeGithubContent(await reader.get(prefix + "/git/blobs/" + entry.sha));
          if (Buffer.byteLength(text) !== entry.size) throw new Error("Incomplete guide.");
          const rules = repositoryAgentRules(text);
          state =
            rules === undefined
              ? "migration"
              : text === renderAgentGuide(centralGuide, repository, rules, branchPolicy)
                ? "current"
                : "drifted";
        }
        const latest = await reader.get(path);
        if (!isJsonRecord(latest) || getJsonString(latest.commit, "sha") !== sha) {
          state = "incomplete";
        }
      } catch {
        state = "incomplete";
      }
      counts[state]++;
    }
  }
  return counts;
}

async function main(): Promise<void> {
  const [mode, repository = "", file = ""] = process.argv.slice(2);
  const guide = await readFile(new URL("../AGENTS.md", import.meta.url), "utf8");
  const policy = readBranchPolicy();
  if (mode === "render" && repository && file) {
    const source = await readFile(file, "utf8");
    const rules = repositoryAgentRules(source);
    if (rules === undefined && source.trimStart().startsWith("# AGENTS")) {
      throw new CliError("Migrate legacy repository rules explicitly before rendering.", 65);
    }
    process.stdout.write(renderAgentGuide(guide, repository, rules ?? source, policy));
    return;
  }
  if (mode !== "audit" || repository || file) {
    throw new CliError(
      "Usage: generate-agent-guide.ts render OWNER/REPO PROJECT_RULES_FILE | audit",
      64
    );
  }
  const token = process.env.AW_INVENTORY_TOKEN ?? "";
  const control = process.env.GITHUB_REPOSITORY ?? "";
  if (
    !token ||
    control !== "fongap-labs/action-worker" ||
    process.env.GITHUB_REF !== "refs/heads/main"
  ) {
    throw new CliError("Agent guide audit requires trusted main and a read token.", 77);
  }
  try {
    const reader = new GithubReader(process.env.GITHUB_API_URL ?? "https://api.github.com", token);
    const counts = await auditAgentGuides(
      reader,
      await readInstallationInventory(reader),
      control,
      guide,
      policy,
      JSON.parse(readRepositoryPolicyText())
    );
    console.log(JSON.stringify(counts));
    await appendLines(process.env.GITHUB_STEP_SUMMARY, [
      "## Agent guide coverage (read only)",
      "",
      ...Object.entries(counts).map(([state, count]) => state + ": " + count),
      "Only managed business branches are counted; private identities and contents withheld.",
    ]);
    if (counts.incomplete > 0) throw new Error("Incomplete audit.");
  } catch {
    throw new CliError("Agent guide audit incomplete; details withheld.", 75);
  }
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
