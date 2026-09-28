#!/usr/bin/env node
// Runs one repository's centrally-owned test pack against a checked-out target.
//
//   node tests/run-pack.mjs <pack> <target_root> [unit|gate|all] [--filter=text]
//
// The pack (this repository, trusted ref) supplies the tests; the target
// (untrusted PR head) is only ever read/imported. Suites are discovered from
// disk, so a suite cannot exist without being executed.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export function planPack(packName, manifest, files) {
  const gate = new Set(manifest.tiers?.gate ?? []);
  for (const name of gate) {
    if (!files.includes(name)) throw new Error(`pack ${packName}: gate lists a missing suite: ${name}`);
  }
  return {
    unit: files.filter((name) => !gate.has(name)),
    gate: files.filter((name) => gate.has(name)),
  };
}

function main() {
  const args = process.argv.slice(2);
  const positional = args.filter((arg) => !arg.startsWith("--"));
  const [packName, targetArg, tier = "all"] = positional;
  const filter = args.find((arg) => arg.startsWith("--filter="))?.slice("--filter=".length);
  if (!packName || !targetArg || !isAbsolute(targetArg) || !["unit", "gate", "all"].includes(tier)) {
    console.error("usage: run-pack.mjs <pack> <absolute target_root> [unit|gate|all] [--filter=text]");
    process.exit(64);
  }
  if (!/^[a-z][a-z0-9-]*$/.test(packName)) {
    console.error(`invalid pack name: ${packName}`);
    process.exit(64);
  }
  const packDir = join(here, "packs", packName);
  const manifestPath = join(packDir, "pack.json");
  if (!existsSync(manifestPath)) {
    console.error(`unknown pack: ${packName}`);
    process.exit(64);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const target = resolve(targetArg);
  const env = { ...process.env, CENTRAL_TEST_TARGET_ROOT: target };

  if (manifest.runtime === "node") {
    const files = readdirSync(packDir)
      .filter((name) => name.endsWith(manifest.suffix))
      .sort();
    const plan = planPack(packName, manifest, files);
    const selected = (tier === "all" ? [...plan.unit, ...plan.gate] : plan[tier]).filter(
      (name) => !filter || name.includes(filter)
    );
    const register = pathToFileURL(join(here, "kit", "register-target.mjs")).href;
    const run = spawnSync(
      process.execPath,
      [
        "--test",
        "--test-concurrency=4",
        "--import",
        register,
        ...selected.map((name) => join(packDir, name)),
      ],
      { cwd: target, env, stdio: "inherit" }
    );
    console.log(`[pack:${packName}:${tier}] ${selected.length} suites`);
    process.exit(run.status ?? 1);
  }

  if (manifest.runtime === "python") {
    env.PYTHONPATH = [target, join(here, "kit", "python"), process.env.PYTHONPATH]
      .filter(Boolean)
      .join(delimiter);
    const command = manifest.command ?? ["python", "-m", "pytest"];
    const run = spawnSync(
      command[0],
      [
        ...command.slice(1),
        packDir,
        `--rootdir=${packDir}`,
        "-c",
        join(packDir, "pytest.ini"),
        "-p",
        "no:cacheprovider",
        "-q",
        ...(filter ? ["-k", filter] : []),
      ],
      { cwd: target, env, stdio: "inherit" }
    );
    console.log(`[pack:${packName}] python`);
    process.exit(run.status ?? 1);
  }

  console.error(`pack ${packName}: unsupported runtime ${manifest.runtime}`);
  process.exit(64);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
