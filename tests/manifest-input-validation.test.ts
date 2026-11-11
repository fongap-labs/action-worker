import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDependencyRepairManifest } from "../scripts/dependency-repair.ts";
import { parseDeployManifest } from "../scripts/deploy-manifest.ts";
import { assertExactKeys, isSafeRelativePath } from "../scripts/lib/manifest-input-validation.ts";

test("shared manifest path validator accepts existing repository-relative forms", () => {
  for (const path of [".", "scripts/deploy.sh", "projects/alpha/file-name_1.txt", "a".repeat(512)]) {
    assert.equal(isSafeRelativePath(path), true, path);
  }
});

test("shared manifest path validator rejects unsafe or oversized inputs", () => {
  for (const path of [
    "",
    "../escape",
    "a/../escape",
    "/absolute",
    "C:\\temp\\file",
    "C:/temp/file",
    "foo\\..\\bar",
    "one\\two",
    "project/空格",
    "foo bar",
    "a".repeat(513),
    null,
    undefined,
    123,
  ]) {
    assert.equal(isSafeRelativePath(path), false, String(path));
  }
});

test("exact-key assertions retain contextual diagnostic messages", () => {
  assert.doesNotThrow(() => assertExactKeys({ a: 1, b: 2 }, ["b", "a"], "Example"));
  assert.throws(
    () => assertExactKeys({ a: 1, b: 2 }, ["a"], "Example"),
    /Example keys are invalid/
  );
});

test("deploy entrypoints and dependency repair paths use the same safety boundary", () => {
  const tooLong = "a".repeat(513);
  assert.throws(() =>
    parseDeployManifest({
      schema_version: "1",
      adapter: "source-script",
      automatic: false,
      ignore_docs_only: true,
      runner_profile: "production-deploy",
      environment: "production",
      entrypoint: tooLong,
    })
  );
  assert.throws(() =>
    parseDependencyRepairManifest({
      schema_version: "1",
      repairs: [
        {
          id: "uv-lock",
          adapter: "uv-lock",
          runner_profile: "linux-standard",
          trusted_actor: "dependabot[bot]",
          trigger_paths: ["pyproject.toml"],
          output_paths: [tooLong],
          tool_version: "0.12.3",
          head_prefix: "dependabot/",
          working_directory: ".",
        },
      ],
    })
  );
});
