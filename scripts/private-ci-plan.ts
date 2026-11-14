import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseExecutionManifest } from "./execution-contract.ts";
import { resolveLinuxShards } from "./resolve-ci-capabilities.ts";
import { appendLines, CliError, handleError, isMain } from "./runtime-command.ts";

export type PrivateCiPlan = { linux_shards: string[]; has_windows: boolean };

export function inspectPrivateCiPlan(value: unknown, hasWindowsScript: boolean): PrivateCiPlan {
  const manifest = value === undefined ? undefined : parseExecutionManifest(value);
  const shards = manifest === undefined ? ["all"] : resolveLinuxShards(value);
  if (manifest) {
    const jobs = manifest.operations.ci?.jobs ?? [];
    const declaresWindows = jobs.some((job) => job.id === "windows");
    if (declaresWindows !== hasWindowsScript) {
      throw new CliError("Private CI manifest and trusted Windows script disagree.", 65);
    }
  }
  return { linux_shards: shards, has_windows: hasWindowsScript };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new CliError("Cannot inspect trusted CI controls.", 65);
  }
}

export async function planFromTrustedControl(root: string): Promise<PrivateCiPlan> {
  if (!root || !(await exists(join(root, ".github/scripts/central-ci.sh")))) {
    throw new CliError("Trusted Linux CI entry point is missing.", 65);
  }
  const path = join(root, ".github/execution-manifest.json");
  let manifest: unknown;
  if (await exists(path)) {
    try {
      manifest = JSON.parse(await readFile(path, "utf8")) as unknown;
    } catch {
      throw new CliError("Trusted CI execution manifest is invalid.", 65);
    }
  }
  return inspectPrivateCiPlan(manifest, await exists(join(root, ".github/scripts/central-ci.ps1")));
}

async function main(): Promise<void> {
  const root = process.argv[2] ?? "";
  const plan = await planFromTrustedControl(root);
  await appendLines(process.env.GITHUB_OUTPUT, [
    "linux_shards=" + JSON.stringify(plan.linux_shards),
    "has_windows=" + plan.has_windows,
  ]);
  console.log(
    "Private CI plan accepted: " +
      plan.linux_shards.length +
      " Linux shard(s), Windows=" +
      plan.has_windows
  );
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
