import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const workflow = readFileSync(".github/workflows/central-ci-sandbox.yml", "utf8");
const windows = workflow.slice(
  workflow.indexOf("  windows:"),
  workflow.indexOf("      # Only centrally authorized private Windows suites")
);
const suite = readFileSync("tests/packs/delta/windows-desktop-ci.ps1", "utf8");

test("only public Delta may restore a pinned cache for its exact Windows dependency graph", () => {
  assert.match(windows, /uses: actions\/cache\/restore@0057852bfaa89a56745cba8c7296529d2fc39830/);
  assert.match(
    windows,
    /if: inputs\.repository == 'fongap-labs\/delta' && inputs\.is_private == 'false'/
  );
  assert.match(windows, /path: \$\{\{ runner\.temp \}\}\/delta-pnpm-store/);
  assert.match(
    windows,
    /key: delta-win-x64-node26\.13\.1-pnpm11\.28\.5-\$\{\{ hashFiles\('target\/pnpm-lock\.yaml', 'target\/pnpm-workspace\.yaml'\) \}\}/
  );
  assert.match(
    suite,
    /\$env:pnpm_config_store_dir = Join-Path \$env:RUNNER_TEMP 'delta-pnpm-store'/
  );
  assert.doesNotMatch(windows, /restore-keys:/);
  assert.doesNotMatch(windows, /uses: actions\/cache@/);
});

test("PR cache writes are forbidden; only a trusted main CI may save", () => {
  assert.match(windows, /uses: actions\/cache\/save@0057852bfaa89a56745cba8c7296529d2fc39830/);
  assert.match(windows, /inputs\.pr_number == '0'/);
  assert.match(windows, /steps\.delta_pnpm_cache\.outputs\.cache-hit != 'true'/);
  assert.match(windows, /if: success\(\) && inputs\.repository == 'fongap-labs\/delta'/);
  assert.match(windows, /steps\.delta_main_cache_seed\.outputs\.eligible == 'true'/);
  assert.match(windows, /EXPECTED_HEAD_SHA: \$\{\{ inputs\.head_sha \}\}/);
  assert.match(windows, /rev-parse HEAD/);
  assert.match(
    windows,
    /ls-remote https:\/\/github\.com\/fongap-labs\/delta\.git refs\/heads\/main/
  );
  assert.match(windows, /\$match\.Groups\[1\]\.Value -cne \$expected/);
  const restore = windows.indexOf("- name: Restore Delta Windows pnpm store");
  const run = windows.indexOf("- name: Run trusted Windows CI");
  const verify = windows.indexOf("- name: Verify current Delta main cache seed");
  const save = windows.indexOf("- name: Save verified Delta main pnpm store");
  assert.ok(restore >= 0 && restore < run && run < verify && verify < save);
});

test("cache never replaces frozen install, full Windows packaging, or executable smoke", () => {
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
    "package:delta-portable",
    "portable-checksum-verification",
    "Copy-Item -LiteralPath $_.FullName -Destination $reuseOutput",
    "Start-Process -FilePath $exe",
  ];
  for (const phrase of required) {
    assert.ok(suite.includes(phrase), `Windows contract missing: ${phrase}`);
  }
  assert.doesNotMatch(windows, /node_modules\s*$/m);
});
