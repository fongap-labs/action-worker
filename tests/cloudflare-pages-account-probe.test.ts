import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";

const file = ".github/workflows/audit-fongapcdn-pages-account.yml";
const workflow = parse(readFileSync(file, "utf8"));

test("Cloudflare Pages account probe is one-shot on main and never writes Cloudflare", () => {
  assert.deepEqual(workflow.permissions, {});
  assert.deepEqual(workflow.on.push.branches, ["main"]);
  assert.deepEqual(workflow.on.push.paths, [file]);
  assert.ok(workflow.on.workflow_dispatch !== undefined);
  const job = workflow.jobs.identify;
  assert.match(job.if, /github\.repository == 'fongap-labs\/action-worker'/);
  assert.match(job.if, /refs\/heads\/main/);
  assert.deepEqual(job.environment, { name: "internal-vault-ops", deployment: false });
  const steps = job.steps;
  assert.equal(steps.length, 1);
  const probe = steps[0];
  assert.deepEqual(probe.env, {
    CF_PAGES_TOKEN: "${{ secrets.CLOUDFLARE_API_TOKEN_PRIMARY }}",
    CF_CONFIGURED_ACCOUNT_ID: "${{ vars.CLOUDFLARE_ACCOUNT_ID_PRIMARY }}",
    CF_TOKEN_ACCOUNT_ID: "7fbb64830cdcae5b80e5729f13b4aeb2",
  });
  assert.match(probe.run, /method: "GET"/);
  assert.match(probe.run, /pages\/projects\/fongapcdn/);
  assert.match(probe.run, /verified_pages_owner/);
  assert.match(probe.run, /configured_account_matches_project/);
  assert.doesNotMatch(probe.run, /(?:POST|PATCH|PUT|DELETE)\s*\//);
  assert.doesNotMatch(probe.run, /gh api|wrangler pages deploy|deploy.sh/);
});
