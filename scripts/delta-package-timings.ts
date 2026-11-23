/** Read-only and failure-neutral diagnostics for trusted Delta Windows CI.
 * Target-maintained JSON is never accepted as CI evidence or printed verbatim.
 */
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

interface Timing {
  stage: string;
  durationMs: number;
}

const MAX_JSON_BYTES = 1024 * 1024;
const MAX_STAGE_MS = 3_600_000;
const PHASES: ReadonlyArray<readonly [string, RegExp]> = [
  ["package-rebuild", /^run build --profile local$/],
  ["package-dsh-pack", /^exec tsx apps\/desktop\/scripts\/pack-local-packages\.ts(?: |$)/],
  ["package-host-pack", /^--dir apps\/desktop-host pack(?: |$)/],
  ["package-vendor-pack", /^run release:pack --family vendor(?: |$)/],
  ["package-native-build", /^--dir native\/system run build:ts$/],
  ["package-native-pack", /^--dir native\/system\/packages\/entry pack(?: |$)/],
  ["package-runtime-prepare", /^run prepare:runtime(?: |$)/],
  ["package-assets-prepare", /^run prepare:packages$/],
  ["package-dsh-prepare", /^run prepare:dsh(?: |$)/],
  ["package-electron-builder", /^exec electron-builder(?: |$)/],
  ["package-runtime-smoke", /^exec tsx scripts\/smoke-packaged-runtime\.ts --unsigned$/],
];

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Whitelist stage labels from an unsigned Win-x64 directory run that completed successfully. */
export function packageTimingMetrics(metadata: unknown, outcome: unknown): Timing[] {
  const run = record(metadata);
  const result = record(outcome);
  if (
    run?.target !== "win-x64" ||
    run.unsigned !== true ||
    run.directory !== true ||
    result?.success !== true ||
    !Array.isArray(result.stages)
  ) {
    return [];
  }
  const found = new Map<string, number>();
  for (const item of result.stages) {
    const stage = record(item);
    if (
      typeof stage?.stage !== "string" ||
      typeof stage.elapsedMs !== "number" ||
      !Number.isFinite(stage.elapsedMs) ||
      stage.elapsedMs < 0 ||
      stage.elapsedMs > MAX_STAGE_MS
    ) {
      continue;
    }
    const name = PHASES.find(([, matcher]) => matcher.test(stage.stage as string))?.[0];
    if (name !== undefined && !found.has(name)) {
      found.set(name, Math.round(stage.elapsedMs));
    }
  }
  return PHASES.filter(([name]) => found.has(name)).map(([name]) => ({
    stage: name,
    durationMs: found.get(name) ?? 0,
  }));
}

function safeReadJson(path: string): unknown {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_JSON_BYTES) return null;
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

/** A broken/missing/untrusted journal is ignored; it never changes CI success. */
function readLatestPackageMetrics(root: string): Timing[] {
  const location = join(root, "apps", "desktop", ".desktop-build", "packaging-runs");
  const directory = lstatSync(location);
  if (!directory.isDirectory() || directory.isSymbolicLink()) return [];
  const runs = readdirSync(location, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => entry.name)
    .sort()
    .reverse()
    .slice(0, 4);
  for (const name of runs) {
    try {
      const dir = join(location, name);
      const metadata = safeReadJson(join(dir, "run.json"));
      const result = safeReadJson(join(dir, "result.json"));
      const metrics = packageTimingMetrics(metadata, result);
      if (metrics.length > 0) return metrics;
    } catch {
      // The target's optional journal must not affect required tests.
    }
  }
  return [];
}

function main(): void {
  const root = process.argv[2];
  if (process.argv.length !== 3 || !root) return;
  try {
    for (const { stage, durationMs } of readLatestPackageMetrics(root)) {
      console.log("Delta Windows CI timing stage=" + stage + " duration_ms=" + durationMs);
    }
  } catch {
    // No paths, target-provided messages or exception content can reach CI logs.
  }
}

if (import.meta.main) main();
