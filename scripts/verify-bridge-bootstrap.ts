import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CliError, isMain, runText } from "./runtime-command.ts";

const bridgePath = ".github/workflows/notify-action-worker.yml";
const changelogPath = "CHANGELOG.md";
const trustedScriptPath = ".github/scripts/central-ci.sh";

type ApprovalEntry = { path?: unknown; sha256?: unknown };

/**
 * A repository with no trusted CI script on its base may only bootstrap the
 * approved notification bridge and its release record. This cannot execute
 * untrusted code or become a fallback for arbitrary source changes.
 */
export function assertBridgeBootstrap(
  changedPaths: readonly string[],
  addedPaths: readonly string[],
  template: string,
  candidate: string,
  approvalEntries: readonly ApprovalEntry[]
): void {
  if (
    changedPaths.length !== 2 ||
    new Set(changedPaths).size !== 2 ||
    !changedPaths.includes(bridgePath) ||
    !changedPaths.includes(changelogPath) ||
    addedPaths.filter((path) => path === bridgePath).length !== 1
  ) {
    throw new CliError(
      "Trusted bootstrap accepts only a new approved bridge and CHANGELOG.md.",
      65
    );
  }
  const digest = createHash("sha256").update(template).digest("hex");
  const entries = approvalEntries.filter((entry) => entry.path === bridgePath);
  if (entries.length !== 1 || entries[0]?.sha256 !== digest || candidate !== template) {
    throw new CliError("Trusted bootstrap bridge differs from the security-approved template.", 65);
  }
}

export async function verifyBridgeBootstrap(
  targetRoot: string,
  base: string,
  head: string,
  workerRoot: string
): Promise<void> {
  if (![base, head].every((sha) => /^[a-f0-9]{40}$/.test(sha))) {
    throw new CliError("Trusted bootstrap requires pinned commits.", 65);
  }
  const baseScript = await runText(
    "git",
    ["ls-tree", "--name-only", base, "--", trustedScriptPath],
    { cwd: targetRoot }
  );
  if (baseScript.trim()) {
    throw new CliError("Trusted CI script exists; bootstrap mode is forbidden.", 65);
  }
  const changed = await runText("git", ["diff", "--no-renames", "--name-only", base, head], {
    cwd: targetRoot,
  });
  const added = await runText(
    "git",
    ["diff", "--no-renames", "--name-only", "--diff-filter=A", base, head],
    { cwd: targetRoot }
  );
  const changedPaths = changed.split("\n").filter(Boolean);
  const addedPaths = added.split("\n").filter(Boolean);
  const bridgeTree = await runText("git", ["ls-tree", head, "--", bridgePath], { cwd: targetRoot });
  if (
    !/^100644 blob [a-f0-9]{40}\t\.github\/workflows\/notify-action-worker\.yml$/.test(
      bridgeTree.trim()
    )
  ) {
    throw new CliError("Trusted bootstrap bridge must be a regular tracked file.", 65);
  }
  const policy = JSON.parse(await readFile(join(workerRoot, "policies/security.json"), "utf8")) as {
    approved_workflows?: ApprovalEntry[];
  };
  if (!Array.isArray(policy.approved_workflows)) {
    throw new CliError("Trusted bootstrap security policy is unavailable.", 65);
  }
  const [template, candidate] = await Promise.all([
    readFile(join(workerRoot, "templates/bridge/notify-action-worker.yml"), "utf8"),
    readFile(join(targetRoot, bridgePath), "utf8"),
  ]);
  assertBridgeBootstrap(changedPaths, addedPaths, template, candidate, policy.approved_workflows);
}

async function main(): Promise<void> {
  const [targetRoot = "", base = "", head = "", workerRoot = ""] = process.argv.slice(2);
  if (!targetRoot || !base || !head || !workerRoot) {
    throw new CliError("Trusted bootstrap requires target, base, head and worker root.", 64);
  }
  await verifyBridgeBootstrap(targetRoot, base, head, workerRoot);
  console.log("Trusted notification bridge bootstrap verified.");
}

if (isMain(import.meta.url)) {
  main().catch(() => {
    console.error("::error::Trusted bridge bootstrap rejected; no source tests bypassed.");
    process.exitCode = 1;
  });
}
