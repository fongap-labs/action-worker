import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CliError, isMain, runText } from "./runtime-command.ts";
import { collectSecurityViolations } from "./validate-security.ts";

// A local, no-network pre-push safety check. The GitHub merge gate remains authoritative.
// Every new commit is checked, including secrets introduced and removed before the tip.
const zeroSha = "0".repeat(40);
const emptyTree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const commitSha = /^[0-9a-f]{40}$/;
const maxNewCommits = 1000;
const maxStdinBytes = 65536;

export type PushRefUpdate = {
  localRef: string;
  localSha: string;
  remoteRef: string;
  remoteSha: string;
};

export type PrivacyPushSummary = {
  checked_commits: number;
  violations: ReadonlyArray<{ rule: string; count: number }>;
};

export function parsePushRefUpdates(input: string): PushRefUpdate[] {
  if (Buffer.byteLength(input, "utf8") > maxStdinBytes) {
    throw new CliError("Too many Git push references to validate.", 65);
  }
  const updates: PushRefUpdate[] = [];
  for (const line of input.split(/\r?\n/)) {
    if (line === "") continue;
    const fields = line.split(" ");
    if (
      fields.length !== 4 ||
      !fields[0] ||
      !fields[2] ||
      !fields[0].startsWith("refs/") ||
      !fields[2].startsWith("refs/") ||
      fields[0].includes("..") ||
      fields[2].includes("..") ||
      !commitSha.test(fields[1] ?? "") ||
      !commitSha.test(fields[3] ?? "")
    ) {
      throw new CliError("Git push reference input is invalid.", 65);
    }
    updates.push({
      localRef: fields[0],
      localSha: fields[1]!,
      remoteRef: fields[2],
      remoteSha: fields[3]!,
    });
  }
  return updates;
}

async function git(root: string, args: string[]): Promise<string> {
  return (await runText("git", args, { cwd: root, maxBuffer: 4 * 1024 * 1024 })).trim();
}

export async function checkPushRefUpdates(
  root: string,
  policyPath: string,
  remote: string,
  updates: readonly PushRefUpdate[]
): Promise<PrivacyPushSummary> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(remote)) {
    throw new CliError("Git remote identifier is invalid.", 65);
  }
  // A zero local SHA denotes a ref deletion, which cannot introduce new bytes.
  const seen = new Set<string>();
  const counts = new Map<string, number>();
  for (const update of updates) {
    if (update.localSha === zeroSha) continue;
    const refs =
      update.remoteSha === zeroSha
        ? [update.localSha, "--not", "--remotes=" + remote]
        : [update.localSha, "^" + update.remoteSha];
    const result = await git(root, ["rev-list", "--reverse", "--max-count=1001", ...refs]);
    const commits = result === "" ? [] : result.split("\n");
    if (commits.length > maxNewCommits) {
      throw new CliError("Git push history exceeds the preflight scan budget.", 65);
    }
    for (const sha of commits) {
      if (!commitSha.test(sha)) throw new CliError("Git commit list is malformed.", 65);
      if (seen.has(sha)) continue;
      seen.add(sha);
      if (seen.size > maxNewCommits) {
        throw new CliError("Git push history exceeds the preflight scan budget.", 65);
      }
      const record = (await git(root, ["rev-list", "--parents", "-n", "1", sha])).split(" ");
      if (record[0] !== sha || record.slice(1).some((parent) => !commitSha.test(parent))) {
        throw new CliError("Git commit ancestry is malformed.", 65);
      }
      const base = record[1] ?? emptyTree;
      const violations = await collectSecurityViolations(root, base, sha, policyPath);
      for (const violation of violations) {
        counts.set(violation.rule, (counts.get(violation.rule) ?? 0) + 1);
      }
    }
  }
  return {
    checked_commits: seen.size,
    violations: [...counts]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([rule, count]) => ({
        rule,
        count,
      })),
  };
}

async function main(): Promise<void> {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk.toString();
    if (Buffer.byteLength(input, "utf8") > maxStdinBytes) {
      throw new CliError("Git push reference input is oversized.", 65);
    }
  }
  const remote = process.argv[2] ?? "";
  const root = await git(process.cwd(), ["rev-parse", "--show-toplevel"]);
  const policyPath = resolve(dirname(fileURLToPath(import.meta.url)), "../policies/security.json");
  // Fail closed if central policy is missing; it is intentionally not fetched over the network.
  await readFile(policyPath, "utf8");
  const summary = await checkPushRefUpdates(root, policyPath, remote, parsePushRefUpdates(input));
  if (summary.violations.length > 0) {
    for (const item of summary.violations) {
      console.error("Privacy pre-push blocked: " + item.rule + " (" + item.count + ")");
    }
    throw new CliError("Privacy pre-push blocked unsafe commit history.", 1);
  }
  console.log("Privacy pre-push passed (" + summary.checked_commits + " new commits checked).");
}

if (isMain(import.meta.url)) {
  // A local path, Git diagnostic or secret value must never reach hook stdout/stderr.
  main().catch(() => {
    console.error("Privacy pre-push could not complete; push blocked. Check local configuration.");
    process.exitCode = 1;
  });
}
