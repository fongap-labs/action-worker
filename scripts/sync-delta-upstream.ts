import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const SOURCE = "https://github.com/deepseek-ai/deepseek-harness.git";
const TARGET = "https://github.com/fongap-labs/delta.git";
const SOURCE_REF = "refs/heads/master";
const MIRROR_REF = "refs/heads/upstream/deepseek-harness";
const MIRROR_BRANCH = "upstream/deepseek-harness";

function run(
  command: string,
  args: string[],
  options?: { timeout?: number; env?: NodeJS.ProcessEnv }
): string {
  return execFileSync(command, args, {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    timeout: options?.timeout ?? 60_000,
    env: options?.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * Do not push upstream workflow definitions that can run on a push to the mirror branch.
 * This is a fail-closed, deliberately strict guard, not an arbitrary-workflow validator.
 */
export function isSafeMirrorWorkflow(source: string, branch = MIRROR_BRANCH): boolean {
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

function assertSafeWorkflowTriggers(repository: string): number {
  const files = run("git", [
    `--git-dir=${repository}`,
    "ls-tree",
    "-r",
    "--name-only",
    SOURCE_REF,
    "--",
    ".github/workflows",
  ])
    .trim()
    .split("\n")
    .filter((name) => /\.ya?ml$/.test(name));
  for (const path of files) {
    const source = run("git", [`--git-dir=${repository}`, "show", `${SOURCE_REF}:${path}`]);
    if (!isSafeMirrorWorkflow(source)) {
      throw new Error(`Unsafe upstream Actions push trigger in ${path}; mirror not updated`);
    }
  }
  return files.length;
}

async function main(): Promise<void> {
  const token = process.env.AW_DELTA_MIRROR_TOKEN;
  if (!token) throw new Error("Missing scoped mirror credential");
  const directory = mkdtempSync(join(tmpdir(), "delta-upstream-"));
  const mirror = join(directory, "upstream.git");
  try {
    // Fetch Git objects only; never checkout, install, or execute upstream code.
    run("git", ["clone", "--bare", "--single-branch", "--branch", "master", SOURCE, mirror], {
      timeout: 900_000,
    });
    const count = assertSafeWorkflowTriggers(mirror);
    const sha = run("git", [`--git-dir=${mirror}`, "rev-parse", SOURCE_REF]).trim();

    // No force: upstream history rewrites or mirror divergence must fail visibly.
    // The app token is supplied via the GitHub CLI credential helper, not a URL.
    const output = run(
      "git",
      [
        `--git-dir=${mirror}`,
        "-c",
        "credential.helper=!gh auth git-credential",
        "push",
        "--porcelain",
        TARGET,
        `${SOURCE_REF}:${MIRROR_REF}`,
      ],
      {
        timeout: 900_000,
        env: {
          ...process.env,
          GH_TOKEN: token,
          GIT_TERMINAL_PROMPT: "0",
        },
      }
    );
    console.log(
      JSON.stringify({
        source: "deepseek-ai/deepseek-harness",
        source_ref: SOURCE_REF,
        destination: "fongap-labs/delta",
        destination_ref: MIRROR_REF,
        sha,
        checked_workflows: count,
        status: output.includes("[up to date]") ? "unchanged" : "synced",
      })
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error: unknown) => {
    console.error(
      "Delta upstream mirror failed:",
      error instanceof Error ? error.message : String(error)
    );
    process.exitCode = 1;
  });
}
