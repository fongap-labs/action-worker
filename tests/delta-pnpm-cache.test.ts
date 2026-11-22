import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const workflow = readFileSync(".github/workflows/central-ci-sandbox.yml", "utf8");
const windows = workflow.slice(
  workflow.indexOf("  windows:"),
  workflow.indexOf("      # Only centrally authorized private Windows suites")
);
const suite = readFileSync("tests/packs/delta/windows-desktop-ci.ps1", "utf8");

test("Delta pnpm cache uses pinned action, OS/tool versions, and immutable lock hash", () => {
  assert.match(windows, /uses: actions\/cache@0057852bfaa89a56745cba8c7296529d2fc39830/);
  assert.match(windows, /if: inputs\.repository == 'fongap-labs\/delta'/);
  assert.match(windows, /path: \$\{\{ runner\.temp \}\}\/delta-pnpm-store/);
  assert.match(
    windows,
    /key: delta-win-x64-node24\.9\.0-pnpm11\.28\.5-\$\{\{ hashFiles\('target\/pnpm-lock\.yaml', 'target\/pnpm-workspace\.yaml'\) \}\}/
  );
  assert.match(
    windows,
    /pnpm_config_store_dir: \$\{\{ runner\.temp \}\}\/delta-pnpm-store/
  );
  assert.doesNotMatch(windows, /restore-keys:/);
});

test("all genuine Windows verification remains mandatory and is never satisfied by cache", () => {
  const required = [
    "delta-verify.mjs",
    "'--frozen-lockfile'",
    "build:lib:host",
    "@fongap-labs/delta-plugin-shared",
    "@fongap-labs/delta-code",
    "build:desktop",
    "local-diagnostics-smoke.mjs",
    "package:win:x64:dir",
    "--unsigned",
    "Copy-Item -LiteralPath $unpacked",
    "Start-Process -FilePath $exe",
  ];
  for (const phrase of required) {
    assert.ok(suite.includes(phrase), "Windows contract missing: " + phrase);
  }
  const cache = windows.indexOf("- name: Cache Delta Windows pnpm store");
  const run = windows.indexOf("- name: Run trusted Windows CI");
  assert.ok(cache >= 0 && run > cache);
  assert.doesNotMatch(windows, /cache-hit/);
  assert.doesNotMatch(windows, /node_modules\s*$/m);
});
