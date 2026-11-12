import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  planPack,
  selectNodePackSuites,
  validatePackManifest,
  validatePackTier,
} from "../run-pack.mjs";

test("planPack splits gate suites from unit suites and rejects unknown gate entries", () => {
  const files = ["a-test.mjs", "b-test.mjs", "c-test.mjs"];
  assert.deepEqual(planPack("p", { tiers: { gate: ["b-test.mjs"] } }, files), {
    unit: ["a-test.mjs", "c-test.mjs"],
    gate: ["b-test.mjs"],
  });
  assert.throws(
    () => planPack("p", { tiers: { gate: ["missing-test.mjs"] } }, files),
    /missing suite/
  );
});

test("node pack tiers never discover target tests when a filter or gate is empty", () => {
  /** @type {{ runtime: "node", tiers: { gate: string[] } }} */
  const manifest = { runtime: "node", tiers: { gate: ["b-test.mjs"] } };
  const files = ["a-test.mjs", "b-test.mjs"];
  assert.deepEqual(selectNodePackSuites("p", manifest, files, "all"), files);
  assert.deepEqual(selectNodePackSuites("p", manifest, files, "unit"), ["a-test.mjs"]);
  assert.deepEqual(selectNodePackSuites("p", manifest, files, "gate"), ["b-test.mjs"]);
  assert.throws(
    () => selectNodePackSuites("p", manifest, files, "all", "no-matching-suite"),
    /no suites match/
  );
  assert.throws(
    () => selectNodePackSuites("p", { runtime: "node" }, files, "gate"),
    /no suites match/
  );
  assert.throws(
    () => planPack("p", { tiers: { gate: ["b-test.mjs", "b-test.mjs"] } }, files),
    /unique list/
  );
  assert.throws(
    () => planPack("p", JSON.parse('{"tiers":{"gate":"b-test.mjs"}}'), files),
    /unique list/
  );
});

test("python packs reject unsupported unit/gate tiers instead of reporting all as a pass", () => {
  /** @type {{ runtime: "python" }} */
  const manifest = { runtime: "python" };
  validatePackTier("example", manifest, "all");
  assert.throws(() => validatePackTier("example", manifest, "unit"), /not defined/);
  assert.throws(() => validatePackTier("example", manifest, "gate"), /not defined/);
});

test("every checked-in target pack has a valid manifest and complete Node tier partition", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "packs");
  const packs = readdirSync(root, { withFileTypes: true }).filter((item) => item.isDirectory());
  assert.ok(packs.length > 0);
  for (const entry of packs) {
    const path = join(root, entry.name);
    const manifest = JSON.parse(readFileSync(join(path, "pack.json"), "utf8"));
    assert.doesNotThrow(() => validatePackManifest(entry.name, manifest), entry.name);
    if (manifest.runtime !== "node") continue;
    const files = readdirSync(path)
      .filter((name) => name.endsWith(manifest.suffix))
      .sort();
    const partition = planPack(entry.name, manifest, files);
    assert.ok(files.length > 0, entry.name);
    assert.deepEqual([...partition.unit, ...partition.gate].sort(), files);
    assert.equal(new Set([...partition.unit, ...partition.gate]).size, files.length);
    assert.deepEqual(selectNodePackSuites(entry.name, manifest, files, "all").sort(), files);
  }
});

test("manifests reject mutable identities, invalid runtime and misleading tiers", () => {
  const valid = JSON.parse(
    '{"schema_version":1,"pack":"example","runtime":"node","suffix":"-test.mjs"}'
  );
  assert.doesNotThrow(() => validatePackManifest("example", valid));
  for (const invalid of [
    { ...valid, schema_version: 2 },
    { ...valid, pack: "other" },
    { ...valid, runtime: "shell" },
    { ...valid, suffix: "../test.mjs" },
    { ...valid, env: ["lowercase"] },
    { ...valid, tiers: { gate: "all" } },
  ]) {
    assert.throws(() => validatePackManifest("example", invalid));
  }
});
