import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const windows = readFileSync("tests/packs/delta/windows-desktop-ci.ps1", "utf8");
const sandbox = readFileSync(".github/workflows/central-ci-sandbox.yml", "utf8");

test("Delta Windows full verification retains all mandatory stages with timing", () => {
  const phases = [
    "product-policy",
    "release-build",
    "package-closure-regression",
    "local-diagnostics-smoke",
    "release-acceptance",
    "release-archive-extraction",
    "portable-relocation",
    "relocated-executable-startup",
  ];
  for (const phase of phases) {
    assert.ok(windows.includes(phase), "missing mandatory phase " + phase);
  }
  assert.match(windows, /\$watch = \[System\.Diagnostics\.Stopwatch\]::StartNew\(\)/);
  assert.match(windows, /\$script:stage, \$watch\.ElapsedMilliseconds/);
  assert.match(windows, /Delta Windows CI timing stage=portable-relocation duration_ms=/);
  assert.match(windows, /Delta Windows CI timing stage=relocated-executable-startup duration_ms=/);
  assert.match(windows, /if \(\$LASTEXITCODE -ne 0\) \{/);
  assert.match(windows, /build-delta-release\.ps1/);
  assert.match(windows, /verify-delta-release\.mjs/);
  assert.doesNotMatch(windows, /DELTA_REUSE_ELECTRON_OUTPUT|package:win:x64:dir/);
  assert.match(windows, /throw "Delta Windows CI child process exited with code \$LASTEXITCODE/);
  assert.match(windows, /throw 'Relocated Delta\.exe did not exit/);
  assert.match(windows, /throw "Relocated Delta\.exe failed its startup probe/);
});

test("public success prints only bounded numeric timings and never private logs", () => {
  const step = sandbox.slice(
    sandbox.indexOf("      - name: Run trusted Windows CI"),
    sandbox.indexOf("      # Only centrally authorized private Windows suites")
  );
  assert.match(step, /\$env:TARGET_PRIVATE -eq "false"/);
  assert.match(step, /\$relative -eq 'tests\/packs\/delta\/windows-desktop-ci\.ps1'/);
  assert.match(step, /duration_ms=\(\[0-9\]\{1,12\}\)/);
  assert.match(step, /Select-Object -First 24/);
  assert.match(step, /Where-Object \{ \$_ -cmatch/);
  assert.match(step, /Write-Error "Central Windows CI failed/);
  assert.match(step, /exit 1/);
});
