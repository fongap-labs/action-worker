import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SHA = /^[a-f0-9]{40}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** Immutable source snapshots approved for one-time repository imports. */
export interface SourceImportBaseline {
  readonly bootstrapSha: string;
  readonly upstreamSha: string;
  readonly sourceRepository?: string;
}

function loadSourceImportBaselines(): readonly SourceImportBaseline[] {
  const path = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "policies",
    "source-import-baselines.json"
  );
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (
    typeof raw !== "object" ||
    raw === null ||
    !("schema_version" in raw) ||
    raw.schema_version !== 1 ||
    !("baselines" in raw) ||
    !Array.isArray(raw.baselines)
  ) {
    throw new Error("Source import baseline policy is invalid.");
  }
  const seen = new Set<string>();
  return raw.baselines.map((entry): SourceImportBaseline => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      !("bootstrap_sha" in entry) ||
      typeof entry.bootstrap_sha !== "string" ||
      !SHA.test(entry.bootstrap_sha) ||
      !("source_sha" in entry) ||
      typeof entry.source_sha !== "string" ||
      !SHA.test(entry.source_sha) ||
      !("source_repository" in entry) ||
      typeof entry.source_repository !== "string" ||
      !REPOSITORY.test(entry.source_repository)
    ) {
      throw new Error("Source import baseline policy contains an invalid record.");
    }
    if (seen.has(entry.bootstrap_sha)) {
      throw new Error("Source import baseline policy contains a duplicate bootstrap commit.");
    }
    seen.add(entry.bootstrap_sha);
    return {
      bootstrapSha: entry.bootstrap_sha,
      upstreamSha: entry.source_sha,
      sourceRepository: `https://github.com/${entry.source_repository}.git`,
    };
  });
}

export const SOURCE_IMPORT_BASELINES = loadSourceImportBaselines();

export function sourceImportBaselineForBase(base: string): SourceImportBaseline | undefined {
  return SOURCE_IMPORT_BASELINES.find((entry) => entry.bootstrapSha === base);
}

export function sourceImportBaselineForSource(sourceSha: string): SourceImportBaseline | undefined {
  return SOURCE_IMPORT_BASELINES.find((entry) => entry.upstreamSha === sourceSha);
}

export function resolveSourceImportBase(base: string): string {
  return sourceImportBaselineForBase(base)?.upstreamSha ?? base;
}

/**
 * Make the exact pinned source commit available to read-only Git comparisons.
 * Fetch only the centrally pinned commit from its fixed public source; no
 * checkout, hooks, or source-controlled commands are executed.
 */
export function ensureSourceImportAvailable(
  root: string,
  bootstrapSha: string
): string | undefined {
  const baseline = sourceImportBaselineForBase(bootstrapSha);
  if (!baseline) return undefined;
  return ensurePinnedImportSourceAvailable(root, baseline);
}

export function ensurePinnedImportSourceAvailable(
  root: string,
  baseline: SourceImportBaseline
): string {
  const runGit = (args: string[]): string =>
    execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 180_000,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      },
    }).trim();

  let objectType = "";
  try {
    objectType = runGit(["cat-file", "-t", baseline.upstreamSha]);
  } catch {
    // A source object absent from the target needs the pinned fetch below.
  }
  if (objectType !== "commit" && baseline.sourceRepository) {
    runGit([
      "fetch",
      "--quiet",
      "--no-tags",
      "--no-recurse-submodules",
      "--filter=blob:none",
      "--depth=1",
      baseline.sourceRepository,
      baseline.upstreamSha,
    ]);
    objectType = runGit(["cat-file", "-t", baseline.upstreamSha]);
  }
  if (objectType !== "commit") {
    throw new Error("Pinned source import baseline is unavailable as a Git commit.");
  }
  const actual = runGit(["rev-parse", "--verify", `${baseline.upstreamSha}^{commit}`]);
  if (actual !== baseline.upstreamSha) {
    throw new Error("Pinned source import baseline does not match its immutable SHA.");
  }
  return baseline.upstreamSha;
}
