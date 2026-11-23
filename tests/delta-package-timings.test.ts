import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { packageTimingMetrics } from "../scripts/delta-package-timings.ts";

const metadata = { target: "win-x64", unsigned: true, directory: true };
const stages = [
  { stage: "run build --profile local", elapsedMs: 120_345 },
  { stage: "run release:pack --family vendor --out C:\\target", elapsedMs: 6500 },
  { stage: "--dir native/system run build:ts", elapsedMs: 3400 },
  { stage: "exec electron-builder --config config.mjs", elapsedMs: 90_250 },
  { stage: "exec tsx scripts/smoke-packaged-runtime.ts --unsigned", elapsedMs: 760 },
];

test("public Windows package metrics use fixed labels and bounded numbers", () => {
  assert.deepEqual(packageTimingMetrics(metadata, { success: true, stages }), [
    { stage: "package-rebuild", durationMs: 120_345 },
    { stage: "package-vendor-pack", durationMs: 6500 },
    { stage: "package-native-build", durationMs: 3400 },
    { stage: "package-electron-builder", durationMs: 90_250 },
    { stage: "package-runtime-smoke", durationMs: 760 },
  ]);
});

test("failed, signed and unrelated runs never emit metrics", () => {
  for (const run of [
    { ...metadata, unsigned: false },
    { ...metadata, directory: false },
    { ...metadata, target: "mac-x64" },
  ]) {
    assert.deepEqual(packageTimingMetrics(run, { success: true, stages }), []);
  }
  assert.deepEqual(packageTimingMetrics(metadata, { success: false, stages }), []);
  assert.deepEqual(packageTimingMetrics(metadata, { success: true, stages: null }), []);
});

test("unknown stages, duplicates and malicious values cannot enter output", () => {
  const input = [
    { stage: "secret=private", elapsedMs: 111 },
    { stage: "run build --profile local", elapsedMs: 12.6 },
    { stage: "run build --profile local", elapsedMs: 999 },
    { stage: "exec electron-builder --x", elapsedMs: Number.NaN },
    { stage: "run prepare:dsh", elapsedMs: 4_000_000 },
    { stage: "--dir native/system run build:ts", elapsedMs: -1 },
  ];
  assert.deepEqual(packageTimingMetrics(metadata, { success: true, stages: input }), [
    { stage: "package-rebuild", durationMs: 13 },
  ]);
});

test("trusted Windows route exposes only allowlisted numeric diagnostics", () => {
  const suite = readFileSync("tests/packs/delta/windows-desktop-ci.ps1", "utf8");
  const central = readFileSync(".github/workflows/central-ci-sandbox.yml", "utf8");
  assert.match(suite, /scripts\/delta-package-timings\.ts/);
  assert.match(suite, /Invoke-Checked 'pnpm\.cmd'/);
  assert.match(central, /package-electron-builder/);
  assert.match(central, /Select-Object -First 24/);
  assert.match(central, /Where-Object \{ \$_ -cmatch \$metricsPattern/);
  assert.match(central, /\$env:TARGET_PRIVATE -eq "false"/);
});
