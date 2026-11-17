import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";

type Step = { name?: string; shell?: string; run?: string; env?: Record<string, unknown> };
type Workflow = { jobs: Record<string, { steps?: Step[] }> };

const jobsByFile: Record<string, string[]> = {
  ".github/workflows/release-app.yml": ["prepare", "build", "attest", "package"],
  ".github/workflows/deploy-source-script.yml": ["prepare", "gateway_variables", "deploy", "record_production_deployment"],
  ".github/workflows/handle-release-dispatch.yml": ["release"],
};

test("release and deploy jobs mask event identity before checkout or credentials", () => {
  for (const [file, jobs] of Object.entries(jobsByFile)) {
    const workflow = parse(readFileSync(file, "utf8")) as Workflow;
    for (const job of jobs) {
      const steps = workflow.jobs[job]?.steps ?? [];
      assert.ok(steps.length > 1, file + ":" + job);
      const first = steps[0];
      assert.ok(first, file + ':' + job + ' has no first step');
      assert.equal(first.name, "Mask release/deploy source identities before checkout or token use");
      assert.equal(first.env, undefined);
      const code = first.run ?? "";
      assert.match(code, /GITHUB_EVENT_PATH/);
      assert.match(code, /add-mask/);
      assert.match(code, /source_repository/);
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
