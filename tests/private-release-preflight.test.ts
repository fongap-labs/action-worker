import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";

type Step = {
  name?: string;
  shell?: string;
  run?: string;
  with?: Record<string, string | boolean>;
};
type Workflow = {
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  jobs: Record<string, { steps: Step[] }>;
};

const file = ".github/workflows/private-release-preflight.yml";

test("private release preflight is read-only and runs only in the source caller", () => {
  const source = readFileSync(file, "utf8");
  const workflow = parse(source) as Workflow;
  assert.deepEqual(Object.keys(workflow.on), ["workflow_call"]);
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.deepEqual(Object.keys(workflow.jobs), ["preflight"]);
  assert.doesNotMatch(
    source,
    /secrets\.|secrets:|environment:|id-token:|attestations:|actions\/upload-artifact|workflow_dispatch:|repository_dispatch:/
  );
  assert.doesNotMatch(source, /continue-on-error|\boutputs:|gh api|curl |::add-mask::/);
});

test("private release preflight rejects moved SHA, unsafe source and bad version", () => {
  const workflow = parse(readFileSync(file, "utf8")) as Workflow;
  const steps = workflow.jobs.preflight?.steps ?? [];
  const guard = steps[0];
  assert.equal(guard?.name, "Require private manual main release at exact SHA");
  const run = guard?.run ?? "";
  for (const required of [
    '"$EVENT" == "workflow_dispatch"',
    '"$IS_PRIVATE" == "true"',
    '"$REF" == "refs/heads/main"',
    '"$SOURCE_SHA" == "$EVENT_SHA"',
    '"$ACTION_WORKER_SHA" =~ ^[0-9a-f]{40}$',
    '"$PRODUCT" =~ ^[a-z0-9]+(-[a-z0-9]+)*$',
    "(-beta",
  ]) {
    assert.ok(run.includes(required), required);
  }
});

test("private source and public control are pinned, credentials are not retained", () => {
  const workflow = parse(readFileSync(file, "utf8")) as Workflow;
  const steps = workflow.jobs.preflight?.steps ?? [];
  const source = steps.find((x) => x.name === "Checkout exact private main source");
  const control = steps.find(
    (x) => x.name === "Checkout immutable public Action Worker control"
  );
  assert.equal(source?.with?.ref, "${{ inputs.source_sha }}");
  assert.equal(control?.with?.ref, "${{ inputs.action_worker_sha }}");
  assert.equal(control?.with?.repository, "fongap-labs/action-worker");
  for (const item of [source, control]) {
    assert.equal(item?.with?.["persist-credentials"], false);
  }
  const verifier = steps.find(
    (x) => x.name === "Check immutable revisions and source-owned release manifest"
  );
  assert.match(verifier?.run ?? "", /git -C source rev-parse HEAD/);
  assert.match(verifier?.run ?? "", /git -C aw rev-parse HEAD/);
  assert.match(verifier?.run ?? "", /release\.manifest\.json/);
  assert.match(verifier?.run ?? "", /jq -e/);
  assert.doesNotMatch(JSON.stringify(steps), /release-build\.ps1|run-scoped-deploy|upload-artifact/);
});
