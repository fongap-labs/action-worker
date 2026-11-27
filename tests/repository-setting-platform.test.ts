import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isUnsupportedPrivateRuleset,
  settingMatchesPlatform,
} from "../scripts/apply-repository-settings.ts";
import { CliError } from "../scripts/runtime-command.ts";

test("private GitHub Free repository may not support the native auto-merge toggle", () => {
  assert.equal(settingMatchesPlatform("allow_auto_merge", true, false, true), true);
  assert.equal(settingMatchesPlatform("allow_auto_merge", true, true, true), true);
});

test("public or unrelated mismatches remain hard errors", () => {
  assert.equal(settingMatchesPlatform("allow_auto_merge", true, false, false), false);
  assert.equal(settingMatchesPlatform("allow_auto_merge", false, true, true), false);
  assert.equal(settingMatchesPlatform("allow_squash_merge", true, false, true), false);
  assert.equal(settingMatchesPlatform("delete_branch_on_merge", true, false, true), false);
  assert.equal(
    settingMatchesPlatform("required_status_checks", "validate-merge", "none", true),
    false
  );
});

test("private ruleset exclusion requires a real plan restriction, never visibility alone", () => {
  const restriction = new CliError(
    "gh: Upgrade to GitHub Pro or make this repository public to enable this feature. (HTTP 403)"
  );
  assert.equal(isUnsupportedPrivateRuleset(restriction, true), true);
  assert.equal(isUnsupportedPrivateRuleset(restriction, false), false);
  for (const error of [
    new CliError("gh: Resource not accessible by integration (HTTP 403)"),
    new CliError("gh: API rate limit exceeded (HTTP 403)"),
    new CliError("gh: Not Found (HTTP 404)"),
    new CliError(
      "gh: Upgrade to GitHub Pro or make this repository public to enable this feature. (HTTP 500)"
    ),
  ]) {
    assert.equal(isUnsupportedPrivateRuleset(error, true), false);
  }
});
