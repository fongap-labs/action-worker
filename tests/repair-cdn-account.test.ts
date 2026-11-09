import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";

const file = ".github/workflows/repair-cdn-account.yml";
const workflow = parse(readFileSync(file, "utf8"));

test("one-shot account repair runs only from trusted main in admin ops", () => {
  assert.deepEqual(workflow.permissions, {});
  assert.deepEqual(workflow.on.push.branches, ["main"]);
  assert.deepEqual(workflow.on.push.paths, [file]);
  assert.deepEqual(Object.keys(workflow.on), ["push"]);
  const job = workflow.jobs.repair;
  assert.match(job.if, /github\.repository == 'fongap-labs\/action-worker'/);
  assert.match(job.if, /refs\/heads\/main/);
  assert.deepEqual(job.environment, { name: "admin-ops", deployment: false });
  assert.equal(job.steps.length, 2);
});

test("only verified variable changes, exact previous value and read-back", () => {
  const [fix, dispatch] = workflow.jobs.repair.steps;
  assert.equal(fix.env.GH_TOKEN, "${{ secrets.AW_ADMIN_TOKEN }}");
  assert.equal(fix.env.EXPECTED_OLD_ACCOUNT, "b9b59740f04e9b80e439ebeea6bc79d1");
  assert.equal(fix.env.VERIFIED_PAGES_ACCOUNT, "7fbb64830cdcae5b80e5729f13b4aeb2");
  assert.match(
    fix.run,
    /repos\/fongap-labs\/action-worker\/environments\/internal-vault-ops\/variables\/CLOUDFLARE_ACCOUNT_ID_PRIMARY/
  );
  assert.match(fix.run, /current.*EXPECTED_OLD_ACCOUNT/);
  assert.match(fix.run, /--method PATCH/);
  assert.match(fix.run, /observed.*VERIFIED_PAGES_ACCOUNT/);
  assert.doesNotMatch(JSON.stringify(workflow), /CLOUDFLARE_API_TOKEN|CLOUDFLARE_API_KEY/);
  assert.equal(dispatch.if, "steps.account.outputs.changed == 'true'");
  assert.equal(dispatch.env.APPROVED_SOURCE_SHA, "6c4dca8c571628766d7c92f47107a4d71f030bda");
  assert.match(dispatch.run, /latest.*APPROVED_SOURCE_SHA/);
  assert.match(dispatch.run, /run-source-script-deploy/);
  assert.match(dispatch.run, /"FongapCDN"/);
  assert.match(dispatch.run, /"production"/);
});
