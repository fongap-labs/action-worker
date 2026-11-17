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
  assert.match(run, /if \[\[ "\$NATIVE_PRIVATE_PILOT" == "true" \]\]; then/);
  assert.match(run, /"\$NATIVE_PRIVATE_RESULT" == "success"/);
  assert.match(run, /"\$LINUX_RESULT" != "skipped"/);
  assert.match(run, /"\$SECURITY_RESULT" != "skipped"/);
  assert.match(run, /"\$WINDOWS_RESULT" != "skipped"/);
  assert.match(run, /description="Private CI isolation contract violated"/);
  assert.match(run, /description="Native private CI evidence failed"/);
  assert.match(run, /state=success[\s\S]*?description="Native private CI evidence verified"/);
  assert.match(run, /node scripts\/write-commit-status\.ts "\$REPOSITORY" "\$HEAD_SHA" "\$state"/);
});

test("unenrolled targets keep the legacy execution path", () => {
  const policy = JSON.parse(readFileSync("policies/private-ci-pilots.json", "utf8")) as {
    repositories: string[];
  };
  assert.deepEqual(policy.repositories, ["fongap-labs/delta-legacy"]);
  assert.ok(source.includes("EVENT_ACTION: ${{ github.event.action }}"));
  assert.ok(source.includes("node scripts/native-ci-enrollment.ts"));
  assert.match(
    jobs.finalize?.steps?.find((step) => step.name === "Publish target status")?.run ?? "",
    /description="Central CI passed"/
  );
});

test("protected private main only reads source-owned CI evidence", () => {
  const refJob = jobs["native-private-ref"];
  assert.equal(
    refJob?.if,
    "needs.prepare.outputs.should_run != 'false' && needs.prepare.outputs.native_private_ref == 'true'"
  );
  assert.deepEqual(refJob?.permissions, {});
  const steps = refJob?.steps ?? [];
  assert.ok(steps.some((step) => step.run?.includes("scripts/private-ref-gate.ts")));
  assert.ok(!steps.some((step) => step.name?.includes("Checkout private target source")));
  assert.equal(jobs.linux?.if, oldPath);
  assert.equal(jobs.security?.if, oldPath);
  const publish = jobs.finalize?.steps?.find((step) => step.name === "Publish target status");
  assert.ok(publish?.run);
  assert.equal(publish.env?.NATIVE_PRIVATE_REF, "${{ needs.prepare.outputs.native_private_ref }}");
  assert.equal(publish.env?.NATIVE_PRIVATE_REF_RESULT, "${{ needs['native-private-ref'].result }}");
  const script = publish.run;
  assert.match(script, /"\$NATIVE_PRIVATE_REF_RESULT" == "success"/);
  assert.match(script, /description="Private main isolation contract violated"/);
  assert.match(script, /description="Native private main CI evidence failed"/);
  assert.match(script, /description="Native private main CI evidence verified"/);
  assert.match(script, /if \[\[ "\$NATIVE_PRIVATE_PILOT" != "true" && "\$NATIVE_PRIVATE_REF" != "true" \]\]/);
  assert.ok(source.includes("node scripts/native-ref-enrollment.ts"));
});
