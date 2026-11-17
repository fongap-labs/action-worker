import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";

type Step = {
  name?: string;
  run?: string;
  shell?: string;
  env?: Record<string, unknown>;
};
type Workflow = { jobs: Record<string, { steps?: Step[] }> };

const paths = [
  [
    ".github/workflows/central-ci-dispatch.yml",
    [
      "prepare",
      "native-private-pilot",
      "native-private-ref",
      "security",
      "finalize",
      "prepare-failure",
    ],
  ],
  [".github/workflows/handle-pr-dispatch.yml", ["govern", "resolve-unfinished"]],
  [".github/workflows/central-ci-sandbox.yml", ["linux", "windows"]],
] as const;

test("sensitive public control-plane jobs mask private identity before any checkout or env", () => {
  for (const [file, jobs] of paths) {
    const parsed = parse(readFileSync(file, "utf8")) as Workflow;
    for (const name of jobs) {
      const steps = parsed.jobs[name]?.steps ?? [];
      assert.ok(steps.length > 1, `${file}:${name}`);
      const first = steps[0];
      assert.equal(first?.name, "Mask target repository and commit identities");
      assert.deepEqual(first?.env, undefined);
      const code = first?.run ?? "";
      assert.match(code, /GITHUB_EVENT_PATH/);
      assert.match(code, /add-mask/);
      assert.doesNotMatch(code, /\$\{\{\s*github\.event\.client_payload/);
      if (first?.shell === "bash") {
        if (file.endsWith("central-ci-dispatch.yml") && name === "prepare") {
          // The job output cannot contain a value previously passed to ::add-mask::.
          // Public commit object IDs must remain available to downstream security jobs.
          assert.match(code, /\.repository, \.base_sha, \.merge_sha/);
          assert.ok(code.includes('test("^[0-9a-f]{40}$")'));
          assert.ok(code.includes("then null"));
          assert.doesNotMatch(code, /\[\.repository, \.head_sha, \.base_sha, \.merge_sha\]/);
        } else {
          assert.match(code, /\.repository, \.head_sha, \.base_sha, \.merge_sha/);
        }
        assert.match(code, /printf '::add-mask::%s\\n'/);
      } else {
        assert.equal(first?.shell, "pwsh");
        assert.match(code, /\$client\.repository/);
        assert.match(code, /\$client\.head_sha/);
      }
    }
  }
});
