import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliError, handleError, isMain } from "./runtime-command.ts";

// Central secret scan of the commits a pull request adds (gitleaks, pinned and checksum-verified).
//
//   node central-secret-scan.ts <target-root> <base-sha> <head-sha> [gitleaks-config]
//
// AW_GITLEAKS_MODE=warn (default) reports findings as warnings and never fails the build;
// AW_GITLEAKS_MODE=enforce fails the build when anything is found. A scan that cannot run (for
// example the download failed) is a warning in warn mode and a failure in enforce mode.
//
// Findings are printed redacted: rule names and counts always; file and line only when the target
// repository is public (TARGET_PRIVATE=false), because this log is public.
//
// GITLEAKS_BIN may point to an existing binary (used by the tests); otherwise the pinned release is
// downloaded and its SHA-256 must match, or nothing is run.

export const GITLEAKS_VERSION = "8.30.1";
export const GITLEAKS_LINUX_X64_SHA256 =
  "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb";

const shaPattern = /^[0-9a-f]{40}$/;

type Finding = { RuleID?: string; File?: string; StartLine?: number };

export type ScanSummary = { count: number; rules: string; annotations: string[] };

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

async function download(directory: string): Promise<string> {
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new CannotRun("unsupported platform");
  }
  const archive = `gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz`;
  const url = `https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/${archive}`;
  let bytes: Buffer;
  try {
    const response = await fetch(url, { redirect: "follow" });
    if (!response.ok) throw new Error(String(response.status));
    bytes = Buffer.from(await response.arrayBuffer());
  } catch {
    throw new CannotRun("download failed");
  }
  if (createHash("sha256").update(bytes).digest("hex") !== GITLEAKS_LINUX_X64_SHA256) {
    throw new CannotRun("checksum of the gitleaks archive does not match the pinned value");
  }
  const path = join(directory, archive);
  await writeFile(path, bytes);
  const unpacked = spawnSync("tar", ["-xzf", path, "-C", directory, "gitleaks"], {
    encoding: "utf8",
  });
  if (unpacked.status !== 0) {
    throw new CannotRun("the archive could not be unpacked");
  }
  return join(directory, "gitleaks");
}

export async function main(argv: string[], environment: NodeJS.ProcessEnv): Promise<number> {
  const [target = "", base = "", head = "", config = ""] = argv;
  const mode = environment.AW_GITLEAKS_MODE || "warn";
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
    const args = [
      "git",
      "--source",
      target,
      "--log-opts",
      `${base}..${head}`,
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
    const ran = bin.endsWith(".mjs")
      ? spawnSync(process.execPath, [bin, ...args], { encoding: "utf8" })
      : spawnSync(bin, args, { encoding: "utf8" });
    if (ran.error || ran.status !== 0) {
      throw new CannotRun("gitleaks failed to run");
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

    const range = `${base.slice(0, 7)}..${head.slice(0, 7)}`;
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
