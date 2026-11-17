import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";

type Step = {
  name?: string;
  run?: string;
  env?: Record<string, string>;
};
type Job = {
  if?: string;
  needs?: string[];
  permissions?: Record<string, unknown>;
  steps?: Step[];
};
const text = readFileSync(".github/workflows/central-ci-dispatch.yml", "utf8");
const jobs = (parse(text) as { jobs: Record<string, Job> }).jobs;

test("only enrolled private ref CI runs the source metadata verifier", () => {
  const native = jobs["native-private-ref"];
  assert.ok(native);
  assert.equal(
    native.if,
    "needs.prepare.outputs.should_run != 'false' && needs.prepare.outputs.native_private_ref == 'true'"
  );
  assert.deepEqual(native.permissions, {});
  assert.ok(native.steps?.some((step) => step.run?.includes("scripts/private-ref-gate.ts")));
  assert.ok(!native.steps?.some((step) => step.name?.includes("Checkout private target source")));
  assert.ok(text.includes("node scripts/native-ref-enrollment.ts"));
  assert.ok(
    text.includes("native_private_ref: ${{ steps.native_ref.outputs.enabled || 'false' }}")
  );
  assert.match(text, /permission-actions: read/);
  assert.match(text, /permission-contents: read/);
});

test("private ref success is the only way to attest an enrolled main commit", () => {
  const finalize = jobs.finalize;
  assert.ok(finalize);
  assert.ok(finalize.needs?.includes("native-private-ref"));
  const publish = finalize.steps?.find((step) => step.name === "Publish target status");
  assert.ok(publish?.run);
  assert.equal(publish.env?.NATIVE_PRIVATE_REF_RESULT, "${{ needs['native-private-ref'].result }}");
  assert.equal(publish.env?.NATIVE_PRIVATE_REF, "${{ needs.prepare.outputs.native_private_ref }}");
  assert.match(publish.run, /if \[\[ "\$NATIVE_PRIVATE_REF" == "true" \]\]; then/);
  assert.match(publish.run, /"\$NATIVE_PRIVATE_REF_RESULT" == "success"/);
  assert.match(publish.run, /"\$LINUX_RESULT" != "skipped"/);
  assert.match(publish.run, /"\$SECURITY_RESULT" != "skipped"/);
  assert.match(publish.run, /"\$WINDOWS_RESULT" != "skipped"/);
  assert.match(publish.run, /description="Private main CI isolation contract violated"/);
  assert.match(publish.run, /description="Native private main CI evidence failed"/);
  assert.match(publish.run, /description="Native private main CI evidence verified"/);
});

test("private main and PR isolation never start legacy public source runners", () => {
  for (const name of ["linux", "security", "windows"]) {
    const expression = jobs[name]?.if;
    assert.ok(expression);
    assert.ok(expression.includes("native_private_pilot != 'true'"));
    assert.ok(expression.includes("native_private_ref != 'true'"));
  }
  assert.match(text, /NATIVE_PRIVATE_PILOT.*NATIVE_PRIVATE_REF.*cancelled/);
  assert.match(text, /description="Central CI passed"/);
});
