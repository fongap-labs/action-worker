import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { parseRuntimeCatalog } from "../scripts/resolve-runtime-versions.mjs";

const script = resolve("scripts/install-windows-toolchain.ps1");
const runtime = parseRuntimeCatalog(
  JSON.parse(readFileSync("policies/dependency-versions.json", "utf8"))
);
const hasPowerShell =
  spawnSync("pwsh", ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"]).status === 0;

test(
  "the Windows installer produces a read-only plan from the central catalog",
  { skip: !hasPowerShell && process.env.GITHUB_ACTIONS !== "true" },
  () => {
    assert.ok(hasPowerShell, "PowerShell is required for the CI bootstrap contract test");
    const directory = mkdtempSync(join(tmpdir(), "toolchain-plan-"));
    const root = join(directory, "custom tools");
    try {
      const result = spawnSync(
        "pwsh",
        ["-NoProfile", "-NonInteractive", "-File", script, "-Root", root],
        { encoding: "utf8", timeout: 20000 }
      );
      assert.equal(result.status, 0, result.stderr);
      const plan = JSON.parse(result.stdout);
      assert.equal(plan.node, runtime.node);
      assert.equal(plan.python, runtime.python);
      assert.equal(plan.pnpm, runtime.pnpm);
      assert.equal(plan.scope, "current-user");
      assert.equal(plan.automatic_install, false);
      assert.ok(plan.python_components.includes("venv"));
      assert.ok(plan.python_excluded.includes("tests"));
      assert.equal(existsSync(root), false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
);

test(
  "the Windows installer rejects path persistence in plan mode",
  { skip: !hasPowerShell && process.env.GITHUB_ACTIONS !== "true" },
  () => {
    assert.ok(hasPowerShell);
    const directory = mkdtempSync(join(tmpdir(), "toolchain-guard-"));
    const root = join(directory, "tools");
    try {
      const result = spawnSync(
        "pwsh",
        ["-NoProfile", "-NonInteractive", "-File", script, "-Root", root, "-PersistPath"],
        { encoding: "utf8", timeout: 20000 }
      );
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Path persistence requires Install or Activate mode/);
      assert.equal(existsSync(root), false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
);
