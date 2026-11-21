import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("first Delta source import uses pinned upstream ownership and a trusted product build", () => {
  const gate = readFileSync("scripts/central-engineering-gate.ts", "utf8");
  const workflow = readFileSync(".github/workflows/central-ci-sandbox.yml", "utf8");
  const firstImport = readFileSync("tests/packs/delta/desktop-build-ci.sh", "utf8");

  for (const source of [gate, workflow]) {
    assert.match(source, /7556dc8dfede03053e35359f2b55dd299da1f3ee/);
  }
  assert.match(gate, /2e39e70496aa02986ca6a820c5d497e816b69d7e/);
  assert.match(workflow, /CENTRAL_CI_BASE_SHA/);
  assert.match(workflow, /TARGET_REPOSITORY/);
  assert.match(workflow, /tests\/packs\/delta\/desktop-build-ci\.sh/);
  assert.ok(
    workflow.indexOf("- name: Enforce central engineering ownership") <
      workflow.indexOf("- name: Run trusted Linux CI")
  );
  assert.match(firstImport, /node scripts\/delta-verify\.mjs/);
  assert.match(firstImport, /pnpm install --frozen-lockfile/);
  assert.match(firstImport, /pnpm run build:desktop/);
  assert.doesNotMatch(firstImport, /GITHUB_TOKEN|AW_CONTROL_TOKEN|AW_APP_PRIVATE_KEY/);
});
