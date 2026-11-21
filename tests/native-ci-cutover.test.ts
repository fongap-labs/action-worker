import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";

type Job = {
  if?: string;
  needs?: string[];
  permissions?: Record<string, unknown>;
  steps?: Array<{ name?: string; run?: string; env?: Record<string, string> }>;
};
const source = readFileSync(".github/workflows/central-ci-dispatch.yml", "utf8");
const jobs = (parse(source) as { jobs: Record<string, Job> }).jobs;
const oldPath =
  "needs.prepare.outputs.should_run != 'false' && needs.prepare.outputs.native_private_pilot != 'true' && needs.prepare.outputs.native_private_ref != 'true'";

test("enrolled private PRs run only the audited source-owned evidence verifier", () => {
  assert.equal(
    jobs["native-private-pilot"]?.if,
    "needs.prepare.outputs.should_run != 'false' && needs.prepare.outputs.native_private_pilot == 'true'"
  );
  assert.equal(jobs.linux?.if, oldPath);
  assert.equal(jobs.security?.if, oldPath);
  assert.equal(
    jobs.windows?.if,
    "needs.prepare.outputs.should_run != 'false' && needs.prepare.outputs.has_windows == 'true' && needs.prepare.outputs.native_private_pilot != 'true' && needs.prepare.outputs.native_private_ref != 'true'"
  );
  assert.deepEqual(jobs["native-private-pilot"]?.permissions, {});
  const steps = jobs["native-private-pilot"]?.steps ?? [];
  assert.ok(steps.some((step) => step.run?.includes("scripts/private-ci-gate.ts")));
  assert.ok(!steps.some((step) => step.name?.includes("Checkout private target source")));
});

test("signed private CI verdict cannot fall back to public runner success", () => {
  const finalize = jobs.finalize;
  assert.deepEqual(finalize?.needs, [
    "prepare",
    "linux",
    "security",
    "windows",
    "native-private-pilot",
    "native-private-ref",
  ]);
  const publish = finalize?.steps?.find((step) => step.name === "Publish target status");
  assert.ok(publish?.run);
  assert.equal(
    publish.env?.NATIVE_PRIVATE_PILOT,
    "${{ needs.prepare.outputs.native_private_pilot }}"
  );
  assert.equal(publish.env?.NATIVE_PRIVATE_RESULT, "${{ needs['native-private-pilot'].result }}");
  const run = publish.run;
  assert.match(run, /elif \[\[ "\$NATIVE_PRIVATE_PILOT" == "true" \]\]; then/);
  assert.match(run, /"\$NATIVE_PRIVATE_RESULT" == "success"/);
  assert.match(run, /"\$LINUX_RESULT" != "skipped"/);
  assert.match(run, /"\$SECURITY_RESULT" != "skipped"/);
  assert.match(run, /"\$WINDOWS_RESULT" != "skipped"/);
  assert.match(run, /description="Private CI isolation contract violated"/);
  assert.match(run, /description="Native private CI evidence failed"/);
  assert.match(run, /state=success[\s\S]*?description="Native private CI evidence verified"/);
  assert.match(run, /node scripts\/write-commit-status\.ts "\$REPOSITORY" "\$HEAD_SHA" "\$state"/);
});

test("unlisted targets retain the existing execution flow", () => {
  const policy = JSON.parse(readFileSync("policies/private-ci-pilots.json", "utf8")) as {
    repositories: string[];
  };
  assert.deepEqual(policy.repositories, []);
  assert.ok(source.includes("EVENT_ACTION: ${{ github.event.action }}"));
  assert.ok(source.includes("node scripts/native-ci-enrollment.ts"));
  assert.match(
    jobs.finalize?.steps?.find((step) => step.name === "Publish target status")?.run ?? "",
    /description="Central CI passed"/
  );
});
