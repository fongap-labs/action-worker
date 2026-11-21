import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

export type MirrorSource = {
  source_repository: string;
  source_branch: string;
  target_repository: string;
  target_branch: string;
  bootstrap_sha: string;
};

const policyFile = "policies/upstream-mirror-sources.json";
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const branchPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const mirrorBranchPattern = /^upstream\/[a-z0-9]+(?:-[a-z0-9]+)*$/;
const commitPattern = /^[a-f0-9]{40}$/;

export function parseMirrorSource(value: unknown): MirrorSource {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Upstream mirror policy must be an object.");
  }
  const root = value as Record<string, unknown>;
  if (root.schema_version !== 1 || !Array.isArray(root.mirrors) || root.mirrors.length !== 1) {
    throw new Error("Upstream mirror policy must contain one explicitly approved source.");
  }
  const raw: unknown = root.mirrors[0];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Upstream mirror source is invalid.");
  }
  const entry = raw as Record<string, unknown>;
  if (
    Object.keys(entry).length !== 5 ||
    typeof entry.source_repository !== "string" ||
    !repositoryPattern.test(entry.source_repository) ||
    typeof entry.source_branch !== "string" ||
    !branchPattern.test(entry.source_branch) ||
    typeof entry.target_repository !== "string" ||
    !repositoryPattern.test(entry.target_repository) ||
    !entry.target_repository.startsWith("fongap-labs/") ||
    entry.target_repository === "fongap-labs/action-worker" ||
    entry.source_repository === entry.target_repository ||
    typeof entry.target_branch !== "string" ||
    !mirrorBranchPattern.test(entry.target_branch) ||
    typeof entry.bootstrap_sha !== "string" ||
    !commitPattern.test(entry.bootstrap_sha)
  ) {
    throw new Error("Upstream mirror identities or bootstrap SHA are invalid.");
  }
  return entry as MirrorSource;
}

export function mirrorUpdateMode(
  currentHead: string,
  expectedBootstrap: string,
  sourceHead: string
): "unchanged" | "bootstrap" | "fast-forward" {
  if (!commitPattern.test(currentHead) || !commitPattern.test(sourceHead)) {
    throw new Error("Upstream mirror Git ref is invalid.");
  }
  if (currentHead === sourceHead) return "unchanged";
  if (currentHead === expectedBootstrap) return "bootstrap";
  return "fast-forward";
}

function remoteHead(url: string, ref: string): string {
  const line = run("git", ["ls-remote", url, ref], { timeout: 60_000 }).trim();
  const parts = line.split(/\s+/);
  if (parts.length !== 2 || !commitPattern.test(parts[0]!) || parts[1] !== ref) {
    throw new Error("Upstream mirror remote ref is missing or unverifiable.");
  }
  return parts[0]!;
}

function run(
  command: string,
  args: string[],
  options?: { timeout?: number; env?: NodeJS.ProcessEnv }
): string {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      timeout: options?.timeout ?? 60_000,
      env: options?.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    if (command === "git" && args.includes("push")) {
      const failure = error as { stdout?: unknown; stderr?: unknown };
      const combined = [failure.stdout, failure.stderr]
        .filter((part) => typeof part === "string" || Buffer.isBuffer(part))
        .map((part) => String(part))
        .join("\n")
        .replace(/(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]+/gu, "[REDACTED]");
      const lines = combined
        .split("\n")
        .filter((line) =>
          /(?:remote:|rejected|permission|workflows|fatal:|error:|unpack)/iu.test(line)
        )
        .slice(-12);
      console.error("Mirror Git push diagnostics:", lines.join(" | ").slice(0, 2400));
    }
    throw error;
  }
}

/**
 * Do not push upstream workflow definitions that can run on a push to the mirror branch.
 * This is a fail-closed, deliberately strict guard, not an arbitrary-workflow validator.
 */
export function isSafeMirrorWorkflow(source: string, branch: string): boolean {
  let value: unknown;
  try {
    value = parse(source) as unknown;
  } catch {
    return false;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const trigger = (value as Record<string, unknown>).on;
  if (typeof trigger === "string") return trigger !== "push";
  if (Array.isArray(trigger)) return !trigger.includes("push");
  if (!trigger || typeof trigger !== "object" || Array.isArray(trigger)) return false;
  const push = (trigger as Record<string, unknown>).push;
  if (push === undefined) return true;
  if (!push || typeof push !== "object" || Array.isArray(push)) return false;
  const config = push as Record<string, unknown>;
  if (Array.isArray(config.tags) && !("branches" in config) && !("branches-ignore" in config)) {
    return config.tags.length > 0;
  }
  if (!Array.isArray(config.branches) || config.branches.length === 0) return false;
  return config.branches.every((name) => {
    if (typeof name !== "string" || name.startsWith("!")) return false;
    let literalPrefix = "";
    for (const character of name) {
      if ("*?[]{}+".includes(character)) break;
      literalPrefix += character;
    }
    if (!literalPrefix) return false;
    if (literalPrefix === name) return name !== branch;
    // Release patterns with a disjoint fixed prefix cannot match the mirror branch.
    return !branch.startsWith(literalPrefix);
  });
}

function assertSafeWorkflowTriggers(
  repository: string,
  sourceRef: string,
  targetBranch: string
): number {
  const files = run("git", [
    `--git-dir=${repository}`,
    "ls-tree",
    "-r",
    "--name-only",
    sourceRef,
    "--",
    ".github/workflows",
  ])
    .trim()
    .split("\n")
    .filter((name) => /\.ya?ml$/.test(name));
  for (const path of files) {
    const source = run("git", [`--git-dir=${repository}`, "show", `${sourceRef}:${path}`]);
    if (!isSafeMirrorWorkflow(source, targetBranch)) {
      throw new Error(`Unsafe upstream Actions push trigger in ${path}; mirror not updated`);
    }
  }
  return files.length;
}

async function main(): Promise<void> {
  const token = process.env.AW_UPSTREAM_MIRROR_TOKEN;
  const approvedTarget = process.env.AW_UPSTREAM_MIRROR_TARGET;
  if (!token || !approvedTarget) throw new Error("Missing scoped mirror identity or credential.");
  if (
    process.env.GITHUB_REPOSITORY !== "fongap-labs/action-worker" ||
    process.env.GITHUB_REF !== "refs/heads/main"
  ) {
    throw new Error("Upstream mirror requires the trusted Action Worker main.");
  }
  const source = parseMirrorSource(JSON.parse(readFileSync(policyFile, "utf8")) as unknown);
  if (source.target_repository !== approvedTarget) {
    throw new Error("Upstream mirror target exceeds the approved writer scope.");
  }
  const access = JSON.parse(readFileSync("policies/repository-access.json", "utf8")) as {
    grants?: Record<string, string[]>;
  };
  if (!access.grants?.[source.target_repository]?.includes("pr")) {
    throw new Error("Upstream mirror target is not an enrolled governed repository.");
  }
  const sourceUrl = `https://github.com/${source.source_repository}.git`;
  const targetUrl = `https://github.com/${source.target_repository}.git`;
  const sourceRef = `refs/heads/${source.source_branch}`;
  const targetRef = `refs/heads/${source.target_branch}`;
  const currentSource = remoteHead(sourceUrl, sourceRef);
  const currentTarget = remoteHead(targetUrl, targetRef);
  const mode = mirrorUpdateMode(currentTarget, source.bootstrap_sha, currentSource);
  if (mode === "unchanged") {
    console.log(JSON.stringify({ status: "unchanged", source_sha: currentSource }));
    return;
  }

  const directory = mkdtempSync(join(tmpdir(), "upstream-mirror-"));
  const mirror = join(directory, "upstream.git");
  try {
    // Fetch complete Git objects, never checkout or run untrusted source.
    run(
      "git",
      ["clone", "--bare", "--single-branch", "--branch", source.source_branch, sourceUrl, mirror],
      { timeout: 900_000 }
    );
    const sha = run("git", [`--git-dir=${mirror}`, "rev-parse", sourceRef]).trim();
    if (sha !== currentSource) {
      throw new Error("Upstream branch moved during source fetch; retry later.");
    }
    const checkedWorkflows = assertSafeWorkflowTriggers(mirror, sourceRef, source.target_branch);

    // Replace only the exact initial LICENSE commit once, guarded by a lease.
    // All subsequent upstream updates must fast-forward, never overwrite divergence.
    const pushArgs = [
      `--git-dir=${mirror}`,
      "-c",
      "credential.helper=!gh auth git-credential",
      "push",
      "--porcelain",
      ...(mode === "bootstrap" ? [`--force-with-lease=${targetRef}:${source.bootstrap_sha}`] : []),
      targetUrl,
      `${sourceRef}:${targetRef}`,
    ];
    run("git", pushArgs, {
      timeout: 900_000,
      env: { ...process.env, GH_TOKEN: token, GIT_TERMINAL_PROMPT: "0" },
    });
    if (remoteHead(targetUrl, targetRef) !== sha) {
      throw new Error("Upstream mirror ref does not match source after push.");
    }
    console.log(
      JSON.stringify({
        source_repository: source.source_repository,
        source_sha: sha,
        target_repository: source.target_repository,
        target_ref: targetRef,
        checked_workflows: checkedWorkflows,
        mode,
        status: "synced",
      })
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error: unknown) => {
    console.error(
      "Upstream mirror failed:",
      error instanceof Error ? error.message : String(error)
    );
    process.exitCode = 1;
  });
}
