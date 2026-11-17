import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";

type Step = { name?: string; shell?: string; run?: string; env?: Record<string, unknown> };
type Workflow = { jobs: Record<string, { steps?: Step[]; outputs?: Record<string, string> }> };

const jobsByFile: Record<string, string[]> = {
  ".github/workflows/release-app.yml": ["build", "attest", "package"],
  ".github/workflows/deploy-source-script.yml": [
    "gateway_variables",
    "deploy",
    "record_production_deployment",
  ],
  ".github/workflows/handle-release-dispatch.yml": ["release"],
};

test("release and deploy jobs mask event identity before checkout or credentials", () => {
  for (const [file, jobs] of Object.entries(jobsByFile)) {
    const workflow = parse(readFileSync(file, "utf8")) as Workflow;
    for (const job of jobs) {
      const steps = workflow.jobs[job]?.steps ?? [];
      assert.ok(steps.length > 1, `${file}:${job}`);
      const first = steps[0];
      assert.ok(first, `${file}:${job} has no first step`);
      assert.equal(
        first.name,
        "Mask release/deploy source identities before checkout or token use"
      );
      assert.equal(first.env, undefined);
      const code = first.run ?? "";
      assert.match(code, /GITHUB_EVENT_PATH/);
      assert.match(code, /add-mask/);
      if (file !== ".github/workflows/handle-release-dispatch.yml") {
        assert.match(code, /source_repository/);
      }
      assert.match(code, /source_sha/);
      assert.match(code, /client_payload/);
      assert.match(code, /inputs/);
      assert.doesNotMatch(code, /\$\{\{\s*(?:github|inputs|needs)\./);
      if (first.shell === "pwsh") {
        assert.match(code, /ConvertFrom-Json/);
        assert.match(code, /-notmatch/);
      } else {
        assert.equal(first.shell, "bash");
        assert.match(code, /jq -r/);
        assert.match(code, /printf '::add-mask::%s\\n'/);
      }
    }
  }
});

test("source-owning prepare jobs never mask values required as cross-job outputs", () => {
  for (const file of [
    ".github/workflows/release-app.yml",
    ".github/workflows/deploy-source-script.yml",
  ]) {
    const workflow = parse(readFileSync(file, "utf8")) as Workflow;
    const prepare = workflow.jobs.prepare;
    assert.ok(prepare);
    assert.ok(prepare.outputs?.source_repository);
    assert.ok(prepare.outputs?.source_sha);
    assert.notEqual(
      prepare.steps?.[0]?.name,
      "Mask release/deploy source identities before checkout or token use"
    );
  }
  const release = parse(
    readFileSync(".github/workflows/handle-release-dispatch.yml", "utf8")
  ) as Workflow;
  const code = release.jobs.release?.steps?.[0]?.run ?? "";
  assert.doesNotMatch(code, /\.source_repository|\.target_repository/);
});
