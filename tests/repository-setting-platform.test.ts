import assert from "node:assert/strict";
import { test } from "node:test";
import { settingMatchesPlatform } from "../scripts/apply-repository-settings.ts";

test("private GitHub Free repository may not support the native auto-merge toggle", () => {
  assert.equal(settingMatchesPlatform("allow_auto_merge", true, false, true), true);
  assert.equal(settingMatchesPlatform("allow_auto_merge", true, true, true), true);
});

test("public or unrelated mismatches remain hard errors", () => {
  assert.equal(settingMatchesPlatform("allow_auto_merge", true, false, false), false);
  assert.equal(settingMatchesPlatform("allow_auto_merge", false, true, true), false);
  assert.equal(settingMatchesPlatform("allow_squash_merge", true, false, true), false);
  assert.equal(settingMatchesPlatform("delete_branch_on_merge", true, false, true), false);
  assert.equal(settingMatchesPlatform("required_status_checks", "validate-merge", "none", true), false);
});
