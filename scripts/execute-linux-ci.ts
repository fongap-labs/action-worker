import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyDeltaDocsBootstrap, verifyPrivateDocsBootstrap } from "./delta-docs-bootstrap.ts";
import { parseExecutionManifest } from "./execution-contract.ts";
import { CliError, handleError, isMain } from "./runtime-command.ts";
import { verifyBridgeBootstrap } from "./verify-bridge-bootstrap.ts";

const bootstrapCommand = ["bash", "{control_root}/.github/scripts/central-ci.sh", "{target_root}"];

export function isDeltaBridgeBootstrapChange(paths: readonly string[]): boolean {
  return (
    paths.length === 2 &&
    new Set(paths).size === 2 &&
    paths.includes(".github/workflows/notify-action-worker.yml") &&
    paths.includes("CHANGELOG.md")
  );
}

export type LinuxManifestChoice =
  | { kind: "bootstrap" }
  | { kind: "node"; script: string; args: string[]; timeoutMs: number };

export function chooseLinuxManifestCommand(
  manifestValue: unknown,
  targetRoot: string,
  shard = "all"
): LinuxManifestChoice {
  const manifest = parseExecutionManifest(manifestValue);
  const jobs = manifest.operations.ci?.jobs ?? [];
  const job = jobs.find((entry) => entry.id === "linux");
  const windows = jobs.find((entry) => entry.id === "windows");
  // Delta's Windows suite is scheduled by a separate central sandbox. Do not
  // silently grant its capabilities to the Linux manifest fallback: accept
  // exactly the centrally reviewed Windows declaration and nothing else.
  const allowedWindows =
    windows !== undefined &&
    windows.runner_profile === "windows-standard" &&
    JSON.stringify(windows.command) ===
      JSON.stringify([
        "pwsh",
        "-NoProfile",
        "-File",
        "{central_root}/tests/packs/delta/windows-desktop-ci.ps1",
        "-TargetRoot",
        "{target_root}",
      ]) &&
    windows.timeout_minutes === 90 &&
    windows.capability_requests.length === 1 &&
    windows.capability_requests[0] === "source.read" &&
    windows.working_directory === undefined &&
    (windows.depends_on?.length ?? 0) === 0 &&
    windows.matrix === undefined &&
    (windows.artifacts?.length ?? 0) === 0;
  if (
    !job ||
    jobs.length !== (windows === undefined ? 1 : 2) ||
    (windows !== undefined && !allowedWindows) ||
    jobs.some((entry) => entry.id !== "linux" && entry.id !== "windows")
  ) {
    throw new CliError(
      "The Linux fallback requires one Linux job and at most one audited Windows job.",
      65
    );
  }
  if (
    job.runner_profile !== "linux-standard" ||
    job.capability_requests.length !== 1 ||
    job.capability_requests[0] !== "source.read" ||
    (job.artifacts?.length ?? 0) !== 0
  ) {
    throw new CliError("Linux fallback cannot grant additional runner capabilities.", 65);
  }
  if (JSON.stringify(job.command) === JSON.stringify(bootstrapCommand)) {
    if (shard !== "all") {
      throw new CliError("The bridge bootstrap cannot declare Linux shards.", 65);
    }
    return { kind: "bootstrap" };
  }
  if (shard !== "all" && !job.matrix?.shard?.includes(shard)) {
    throw new CliError("The requested Linux shard was not declared.", 65);
  }
  if (
    job.command[0] !== "node" ||
    job.command.length < 2 ||
    !job.command[1]?.startsWith("{target_root}/") ||
    job.command.slice(2).some((argument) => /[{}]/.test(argument)) ||
    job.working_directory !== undefined
  ) {
    throw new CliError("Manifest CI requires a checked-out Node.js project script.", 65);
  }
  const relativeScript = job.command[1].slice("{target_root}/".length);
  if (
    relativeScript === "" ||
    relativeScript.split("/").some((piece) => piece === ".." || piece === "") ||
    !/\.m?js$/.test(relativeScript)
  ) {
    throw new CliError("The manifest CI script path is unsafe.", 65);
  }
  const target = realpathSync(targetRoot);
  let script: string;
  try {
    script = realpathSync(join(target, relativeScript));
  } catch {
    throw new CliError("The manifest CI script is unavailable.", 65);
  }
  const pathWithinTarget = relative(target, script);
  if (
    pathWithinTarget === "" ||
    pathWithinTarget === ".." ||
    pathWithinTarget.startsWith(".." + sep)
  ) {
    throw new CliError("The manifest CI script must remain in the target source.", 65);
  }
  return {
    kind: "node",
    script,
    args: [...job.command.slice(2), ...(shard === "all" ? [] : [shard])],
    timeoutMs: job.timeout_minutes * 60_000,
  };
}

// A pre-feature baseline may omit the contract. Once introduced, the candidate
// cannot remove it or its package entrypoint to avoid the centrally owned suite.
export function needsDeltaDesignTokenContract(targetRoot: string, controlRoot: string): boolean {
  const path = "scripts/design-token-contract.ts";
  const hasContract = (root: string): boolean =>
    existsSync(join(root, path)) ||
    (existsSync(join(root, "package.json")) &&
      Object.hasOwn(
        JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts ?? {},
        "verify-design-token-contract"
      ));
  return hasContract(targetRoot) || hasContract(controlRoot);
}

export async function executeManifestLinuxCi(
  targetRoot: string,
  controlRoot: string,
  base: string,
  head: string,
  shard = "all"
): Promise<void> {
  const manifestPath = join(controlRoot, ".github/execution-manifest.json");
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
  } catch {
    if (!existsSync(manifestPath) && process.env.TARGET_REPOSITORY === "fongap-labs/delta") {
      const diff = spawnSync("git", ["diff", "--no-renames", "--name-only", base, head, "--"], {
        cwd: targetRoot,
        encoding: "utf8",
        timeout: 15_000,
        maxBuffer: 64 * 1024,
      });
      if (diff.error || diff.status !== 0 || typeof diff.stdout !== "string") {
        throw new CliError("Delta bootstrap could not verify immutable changed paths.", 65);
      }
      if (isDeltaBridgeBootstrapChange(diff.stdout.split("\n").filter(Boolean))) {
        if (shard !== "all" || process.env.TARGET_PRIVATE !== "false") {
          throw new CliError(
            "Trusted Delta bridge onboarding requires an unsharded public target.",
            65
          );
        }
        await verifyBridgeBootstrap(
          targetRoot,
          base,
          head,
          resolve(dirname(fileURLToPath(import.meta.url)), "..")
        );
        console.log("Trusted Delta notification bridge bootstrap verified.");
      } else {
        verifyDeltaDocsBootstrap(targetRoot, controlRoot, base, head, shard);
      }
      return;
    }
    if (!existsSync(manifestPath) && process.env.TARGET_PRIVATE === "true") {
      verifyPrivateDocsBootstrap(targetRoot, controlRoot, base, head, shard);
      return;
    }
    throw new CliError("Trusted Linux CI manifest is missing or invalid.", 65);
  }
  const selected = chooseLinuxManifestCommand(manifest, targetRoot, shard);
  if (selected.kind === "bootstrap") {
    await verifyBridgeBootstrap(
      targetRoot,
      base,
      head,
      resolve(dirname(fileURLToPath(import.meta.url)), "..")
    );
    console.log("Trusted notification bridge bootstrap verified.");
    return;
  }
  if (process.env.TARGET_PRIVATE !== "false") {
    throw new CliError("Manifest CI is only available for verified public targets.", 65);
  }
  // The checkout and immutable SHA are verified by the preceding central sandbox steps.
  // Direct process execution (no shell) prevents manifest argument shell injection.
  const ran = spawnSync(process.execPath, [selected.script, ...selected.args], {
    cwd: targetRoot,
    stdio: "inherit",
    timeout: selected.timeoutMs,
  });
  if (ran.error || ran.status !== 0) {
    throw new CliError("Trusted manifest CI execution failed.", ran.status || 65);
  }
  if (
    process.env.TARGET_REPOSITORY === "fongap-labs/delta" &&
    needsDeltaDesignTokenContract(targetRoot, controlRoot)
  ) {
    const suite = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../tests/packs/delta/design-token-contract-test.mjs"
    );
    const result = spawnSync(process.execPath, ["--experimental-strip-types", suite, targetRoot], {
      cwd: targetRoot,
      stdio: "inherit",
      timeout: 120_000,
    });
    if (result.error || result.status !== 0) {
      throw new CliError("Central Delta design token contract failed.", result.status || 65);
    }
  }
}

if (isMain(import.meta.url)) {
  const [target = "", control = "", base = "", head = "", shard = "all"] = process.argv.slice(2);
  if (!target || !control || !/^[0-9a-f]{40}$/.test(base) || !/^[0-9a-f]{40}$/.test(head)) {
    throw new CliError("Usage: execute-linux-ci.ts <target> <control> <base> <head> [shard]", 64);
  }
  executeManifestLinuxCi(target, control, base, head, shard).catch(handleError);
}
