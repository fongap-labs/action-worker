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
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildPackEnv, buildPythonPackEnv } from "./kit/pack-env.mjs";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * @typedef {object} PackManifest
 * @property {"node" | "python"} [runtime] "node" or "python".
 * @property {string} [suffix] File-name suffix of a node pack's suites.
 * @property {string[]} [command] Command that starts a python pack.
 * @property {{ gate?: string[] }} [tiers] Suites that belong to the gate tier.
 * @property {string[]} [env] Process.env names forwarded to the test subprocess.
 */

/**
 * @param {string} packName
 * @param {PackManifest} manifest
 * @param {string[]} files
 * @returns {{ unit: string[], gate: string[] }}
 */
export function planPack(packName, manifest, files) {
  const declared = manifest.tiers?.gate ?? [];
  if (
    !Array.isArray(declared) ||
    !declared.every((name) => typeof name === "string") ||
    new Set(declared).size !== declared.length
  ) {
    throw new Error(`pack ${packName}: gate suites must be a unique list of filenames`);
  }
  const gate = new Set(declared);
  for (const name of gate) {
    if (!files.includes(name)) throw new Error(`pack ${packName}: gate lists a missing suite: ${name}`);
  }
  return {
    unit: files.filter((name) => !gate.has(name)),
    gate: files.filter((name) => gate.has(name)),
  };
}

/**
 * @param {string} packName
 * @param {PackManifest & { schema_version?: number, pack?: string }} manifest
 */
export function validatePackManifest(packName, manifest) {
  if (
    !manifest ||
    typeof manifest !== "object" ||
    Array.isArray(manifest) ||
    manifest.schema_version !== 1 ||
    manifest.pack !== packName ||
    !["node", "python"].includes(manifest.runtime)
  ) {
    throw new Error(`pack ${packName}: invalid manifest identity, schema or runtime`);
  }
  if (
    manifest.env !== undefined &&
    (!Array.isArray(manifest.env) ||
      !manifest.env.every((name) => typeof name === "string" && /^[A-Z][A-Z0-9_]*$/.test(name)))
  ) {
    throw new Error(`pack ${packName}: env must list valid environment variable names`);
  }
  if (manifest.runtime === "node") {
    if (typeof manifest.suffix !== "string" || !/^-[a-z0-9-]+\.mjs$/.test(manifest.suffix)) {
      throw new Error(`pack ${packName}: node suite suffix is invalid`);
    }
    if (manifest.command !== undefined) {
      throw new Error(`pack ${packName}: node packs cannot declare a python command`);
    }
  } else if (
    manifest.command !== undefined &&
    (!Array.isArray(manifest.command) ||
      manifest.command.length === 0 ||
      !manifest.command.every((arg) => typeof arg === "string" && arg.length > 0))
  ) {
    throw new Error(`pack ${packName}: python command must contain non-empty arguments`);
  }
  if (
    manifest.tiers !== undefined &&
    (typeof manifest.tiers !== "object" ||
      manifest.tiers === null ||
      Array.isArray(manifest.tiers) ||
      !Array.isArray(manifest.tiers.gate))
  ) {
    throw new Error(`pack ${packName}: tiers.gate must be a list`);
  }
}

/**
 * @param {string} packName
 * @param {PackManifest} manifest
 * @param {"unit" | "gate" | "all"} tier
 */
export function validatePackTier(packName, manifest, tier) {
  if (!["unit", "gate", "all"].includes(tier)) {
    throw new Error(`pack ${packName}: unsupported tier ${tier}`);
  }
  // Unlike Node packs, Python packs do not declare gate membership. Running
  // "unit" or "gate" as though it meant "all" would give a false green verdict.
  if (manifest.runtime === "python" && tier !== "all") {
    throw new Error(`pack ${packName}: python unit/gate tiers are not defined; use all or --filter`);
  }
}

/**
 * @param {string} packName
 * @param {PackManifest} manifest
 * @param {string[]} files
 * @param {"unit" | "gate" | "all"} tier
 * @param {string | undefined} filter
 */
export function selectNodePackSuites(packName, manifest, files, tier, filter) {
  validatePackTier(packName, manifest, tier);
  const plan = planPack(packName, manifest, files);
  const selected = (tier === "all" ? [...plan.unit, ...plan.gate] : plan[tier]).filter(
    (name) => !filter || name.includes(filter)
  );
  if (selected.length === 0) {
    // Without explicit files, node --test discovers tests from cwd, which is
    // the untrusted target checkout in central CI. Never fall back to it.
    throw new Error(`pack ${packName}: no suites match tier ${tier} or filter ${filter ?? ""}`);
  }
  return selected;
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
  /** @type {PackManifest} */
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  validatePackManifest(packName, manifest);
  validatePackTier(packName, manifest, tier);
  const target = resolve(targetArg);
  // Allow-listed environment: base OS vars plus names the pack declares in
  // pack.json. Host secrets (CI tokens, local dev keys) are never forwarded.
  const env =
    manifest.runtime === "python"
      ? buildPythonPackEnv(manifest, target, join(here, "kit", "python"))
      : buildPackEnv(manifest, target);

  if (manifest.runtime === "node") {
    const files = readdirSync(packDir)
      .filter((name) => name.endsWith(/** @type {string} */ (manifest.suffix)))
      .sort();
    const selected = selectNodePackSuites(packName, manifest, files, tier, filter);
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
    const command = manifest.command ?? ["python", "-m", "pytest"];
    const run = spawnSync(
      /** @type {string} */ (command[0]),
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
