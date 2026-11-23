import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { engineeringOwnershipDiffBase } from "./engineering-gate-api.ts";
import { CliError, handleError, isMain } from "./runtime-command.ts";

// Central secret scan of the commits a pull request adds (gitleaks, pinned and checksum-verified).
//
//   node central-secret-scan.ts <target-root> <base-sha> <head-sha> [gitleaks-config]
//
// AW_GITLEAKS_MODE=enforce (default) fails the build when findings are found. A scan that cannot
// run (for example the download failed) also fails closed. Set warn explicitly to downgrade it.
//
// Findings are printed redacted: rule names and counts always; file and line only when the target
// repository is public (TARGET_PRIVATE=false), because this log is public.
//
// GITLEAKS_BIN may point to an existing binary (used by the tests); otherwise the pinned release is
// downloaded and its SHA-256 must match, or nothing is run.

export const GITLEAKS_VERSION = "8.30.1";
export const GITLEAKS_LINUX_X64_SHA256 =
  "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb";
// Same pinned upstream release asset, available through the official GitHub API
// when the ordinary github.com release download endpoint is unavailable.
export const GITLEAKS_LINUX_X64_ASSET_ID = 378332058;

export function gitleaksDownloadSources(): ReadonlyArray<{ url: string; headers: string[] }> {
  const archive = `gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz`;
  return [
    {
      url: `https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/${archive}`,
      headers: [],
    },
    {
      url: `https://api.github.com/repos/gitleaks/gitleaks/releases/assets/${GITLEAKS_LINUX_X64_ASSET_ID}`,
      headers: ["Accept: application/octet-stream", "X-GitHub-Api-Version: 2022-11-28"],
    },
  ];
}

const shaPattern = /^[0-9a-f]{40}$/;

type Finding = { RuleID?: string; File?: string; StartLine?: number };

export type ScanSummary = { count: number; rules: string; annotations: string[] };

// Only publish a fixed error category. Raw scanner stderr can contain private file names,
// Git patch content, or secret candidates and must never enter public CI logs.
export function scannerFailureReason(
  status: number | null,
  signal: NodeJS.Signals | null,
  error: NodeJS.ErrnoException | undefined,
  stderr: string
): string {
  if (error?.code === "ENOBUFS") return "scanner output exceeded the bounded capture buffer";
  if (error?.code === "ENOENT") return "scanner executable not found";
  if (error?.code === "EACCES") return "scanner executable cannot be executed";
  if (error) return "scanner process could not start";
  if (signal) return "scanner terminated by a signal";
  if (/unknown flag|unknown shorthand flag|unknown command/i.test(stderr))
    return "scanner rejected a CLI option";
  if (/invalid.*config|failed to.*config|config.*(?:error|parse)/i.test(stderr))
    return "scanner rejected its configuration";
  if (
    /fatal: bad revision|unknown revision|ambiguous argument|bad object|not a git repository/i.test(
      stderr
    )
  )
    return "scanner could not resolve the Git commit range";
  if (status !== null) return `scanner exited with code ${status}`;
  return "scanner exited without a status";
}

export function summarizeFindings(findings: unknown, isTargetPublic: boolean): ScanSummary {
  if (!Array.isArray(findings)) {
    throw new CliError("unreadable gitleaks report", 65);
  }
  const counts = new Map<string, number>();
  for (const item of findings as Finding[]) {
    const rule = String(item.RuleID ?? "unknown");
    counts.set(rule, (counts.get(rule) ?? 0) + 1);
  }
  const annotations = isTargetPublic
    ? (findings as Finding[])
        .slice(0, 20)
        .map(
          (item) =>
            `::warning file=${item.File},line=${item.StartLine}::${item.RuleID} (secret redacted)`
        )
    : [];
  return {
    count: findings.length,
    rules: [...counts].map(([rule, n]) => `${rule} x${n}`).join(", "),
    annotations,
  };
}

class CannotRun extends Error {}

export function downloadFailureReason(
  exitCode: number | null,
  signal: NodeJS.Signals | null,
  error: NodeJS.ErrnoException | undefined,
  httpStatus: string
): string {
  if (error?.code === "ENOENT") return "curl executable not found";
  if (error?.code === "ETIMEDOUT") return "download timed out";
  if (signal) return "download process terminated by a signal";
  if (/^[45]\d{2}$/.test(httpStatus)) return `download returned HTTP ${httpStatus}`;
  if (exitCode !== 0) return `download process failed with code ${exitCode ?? "unknown"}`;
  return "download did not return HTTP 200";
}

async function download(directory: string): Promise<string> {
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new CannotRun("unsupported platform");
  }
  const archive = `gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz`;
  const path = join(directory, archive);
  // Only the pinned GitHub Release and the GitHub REST asset endpoint are
  // accepted. Both may redirect, but never to HTTP. Each candidate is subject
  // to the same fixed archive SHA-256 check below; failures never skip scanning.
  let hasDownloadedArchive = false;
  let lastFailure = "download did not return HTTP 200";
  for (const source of gitleaksDownloadSources()) {
    const downloaded = spawnSync(
      "curl",
      [
        "--fail",
        "--location",
        "--silent",
        "--show-error",
        "--retry",
        "3",
        "--retry-all-errors",
        "--retry-delay",
        "1",
        "--connect-timeout",
        "15",
        "--max-time",
        "180",
        "--max-filesize",
        "20000000",
        "--proto",
        "=https",
        "--proto-redir",
        "=https",
        ...source.headers.flatMap((header) => ["--header", header]),
        "--output",
        path,
        "--write-out",
        "%{http_code}",
        source.url,
      ],
      { encoding: "utf8", timeout: 190_000, maxBuffer: 1024 * 1024 }
    );
    const httpStatus = (downloaded.stdout ?? "").trim();
    if (!downloaded.error && downloaded.status === 0 && httpStatus === "200") {
      hasDownloadedArchive = true;
      break;
    }
    lastFailure = downloadFailureReason(
      downloaded.status,
      downloaded.signal,
      downloaded.error,
      httpStatus
    );
  }
  if (!hasDownloadedArchive) throw new CannotRun(lastFailure);
  const bytes = await readFile(path);
  if (createHash("sha256").update(bytes).digest("hex") !== GITLEAKS_LINUX_X64_SHA256) {
    throw new CannotRun("checksum of the gitleaks archive does not match the pinned value");
  }
  const unpacked = spawnSync("tar", ["-xzf", path, "-C", directory, "gitleaks"], {
    encoding: "utf8",
  });
  if (unpacked.status !== 0) {
    throw new CannotRun("the archive could not be unpacked");
  }
  return join(directory, "gitleaks");
}

/** Construct one unattached scan commit with the Delta tree and centrally pinned upstream parent.
 * This preserves gitleaks' commit-diff semantics even when imported histories are unrelated.
 * Never scans fewer changed lines: all content differing from the pinned source is included.
 */
export function syntheticImportScanCommit(target: string, upstream: string, head: string): string {
  const git = (args: string[], input?: string): string => {
    const ran = spawnSync("git", ["-C", target, ...args], {
      encoding: "utf8",
      input,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Central Security",
        GIT_AUTHOR_EMAIL: "scanner@invalid",
        GIT_COMMITTER_NAME: "Central Security",
        GIT_COMMITTER_EMAIL: "scanner@invalid",
      },
    });
    if (ran.error || ran.status !== 0) {
      throw new CannotRun("pinned import commit could not be verified");
    }
    return ran.stdout.trim();
  };
  if (
    git(["rev-parse", "--verify", upstream + "^{commit}"]) !== upstream ||
    git(["rev-parse", "--verify", head + "^{commit}"]) !== head
  ) {
    throw new CannotRun("pinned import commit identity mismatch");
  }
  const tree = git(["rev-parse", head + "^{tree}"]);
  const scanCommit = git(
    ["commit-tree", tree, "-p", upstream],
    "Synthetic delta import security tree comparison\n"
  );
  if (!shaPattern.test(scanCommit)) {
    throw new CannotRun("synthetic import scan commit is invalid");
  }
  return scanCommit;
}

export async function main(argv: string[], environment: NodeJS.ProcessEnv): Promise<number> {
  const [target = "", base = "", head = "", config = ""] = argv;
  const mode = environment.AW_GITLEAKS_MODE || "enforce";
  if (!target || !base || !head) {
    throw new CliError(
      "Usage: central-secret-scan.ts <target-root> <base-sha> <head-sha> [config]",
      64
    );
  }
  if (mode !== "warn" && mode !== "enforce") {
    throw new CliError("AW_GITLEAKS_MODE must be warn or enforce.", 64);
  }
  if (!shaPattern.test(base) || !shaPattern.test(head)) {
    throw new CliError("base and head must be full commit SHAs.", 64);
  }

  const failOrSkip = (reason: string): number => {
    if (mode === "enforce") {
      console.error(`::error::central secret scan could not run: ${reason}`);
      return 1;
    }
    console.log(`::warning::central secret scan could not run and was skipped: ${reason}`);
    return 0;
  };

  try {
    const work = await mkdtemp(join(environment.RUNNER_TEMP || tmpdir(), "gitleaks-"));
    const bin = environment.GITLEAKS_BIN || (await download(work));
    const report = join(work, "report.json");
    const comparisonBase = engineeringOwnershipDiffBase(base);
    const scanHead =
      comparisonBase === base ? head : syntheticImportScanCommit(target, comparisonBase, head);
    const args = [
      "git",
      target,
      "--log-opts",
      `${comparisonBase}..${scanHead}`,
      "--report-format",
      "json",
      "--report-path",
      report,
      "--redact",
      "--no-banner",
      "--exit-code",
      "0",
    ];
    if (config) args.push("--config", config);
    // A JavaScript stand-in (used by the tests, which also run on Windows) is started through node.
    const options = { encoding: "utf8" as const, maxBuffer: 8 * 1024 * 1024 };
    const ran = bin.endsWith(".mjs")
      ? spawnSync(process.execPath, [bin, ...args], options)
      : spawnSync(bin, args, options);
    if (ran.error || ran.status !== 0) {
      throw new CannotRun(
        scannerFailureReason(ran.status, ran.signal, ran.error, ran.stderr ?? "")
      );
    }
    let summary: ScanSummary;
    try {
      summary = summarizeFindings(
        JSON.parse(await readFile(report, "utf8")),
        environment.TARGET_PRIVATE === "false"
      );
    } catch {
      throw new CannotRun("unreadable gitleaks report");
    }

    const range = `${comparisonBase.slice(0, 7)}..${head.slice(0, 7)}`;
    if (summary.count === 0) {
      console.log(`central secret scan: no findings in ${range}`);
      return 0;
    }
    console.log(
      `::warning::central secret scan: ${summary.count} finding(s) in ${range} (rules: ${summary.rules})`
    );
    for (const line of summary.annotations) console.log(line);
    if (mode === "enforce") {
      console.error(`::error::central secret scan found ${summary.count} finding(s)`);
      return 1;
    }
    return 0;
  } catch (error) {
    if (error instanceof CannotRun) {
      return failOrSkip(error.message);
    }
    if (mode === "warn") {
      return failOrSkip("it stopped unexpectedly");
    }
    throw error;
  }
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2), process.env)
    .then((code) => {
      process.exitCode = code;
    })
    .catch(handleError);
}
