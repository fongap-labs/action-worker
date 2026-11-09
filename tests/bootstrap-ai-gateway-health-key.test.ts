import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";
import {
  assertHealthKeyIsUninitialized,
  environmentSecretNames,
} from "../scripts/bootstrap-ai-gateway-health-key.ts";

test("environment inventory requires complete, unique names, never secret values", () => {
  assert.deepEqual(
    environmentSecretNames({
      total_count: 2,
      secrets: [{ name: "CLOUDFLARE_API_TOKEN" }, { name: "ANOTHER_SECRET" }],
    }),
    ["CLOUDFLARE_API_TOKEN", "ANOTHER_SECRET"]
  );
  for (const bad of [
    null,
    [],
    { total_count: 1, secrets: [] },
    { total_count: 0, secrets: [{ name: "A" }] },
    { total_count: 2, secrets: [{ name: "A" }, { name: "A" }] },
    { total_count: 1, secrets: [{ invalid: "value" }] },
  ]) {
    assert.throws(() => environmentSecretNames(bad), /inventory/);
  }
});

test("bootstrap cannot overwrite Cloudflare or either GitHub Environment key", () => {
  assert.doesNotThrow(() =>
    assertHealthKeyIsUninitialized(["SOME_OTHER_KEY"], [["CLOUDFLARE_API_TOKEN"], []])
  );
  assert.throws(
    () => assertHealthKeyIsUninitialized(["AIG_DEPLOY_HEALTH_KEY"], [[], []]),
    /refusing to rotate/
  );
  assert.throws(
    () => assertHealthKeyIsUninitialized([], [["AIG_DEPLOY_HEALTH_KEY"], []]),
    /refusing to rotate/
  );
  assert.throws(
    () => assertHealthKeyIsUninitialized([], [[], ["AIG_DEPLOY_HEALTH_KEY"]]),
    /refusing to rotate/
  );
  assert.throws(() => assertHealthKeyIsUninitialized([], [[]]), /incomplete/);
});

test("one-shot main-only bootstrap separates Cloudflare and admin secrets scopes", () => {
  const workflow = parse(
    readFileSync(".github/workflows/bootstrap-health-key.yml", "utf8")
  ) as Record<string, unknown>;
  const trigger = workflow.on as { push: { branches: string[]; paths: string[] } };
  assert.deepEqual(trigger.push.branches, ["main"]);
  assert.deepEqual(trigger.push.paths, ["policies/ai-gateway-health-bootstrap.request"]);
  const jobs = workflow.jobs as Record<string, Record<string, unknown>>;
  assert.deepEqual(Object.keys(jobs), ["worker-preflight", "github-bootstrap", "worker-publish"]);
  assert.equal((jobs["worker-preflight"]?.environment as { name: string }).name, "ai-gateway-ops");
  assert.equal((jobs["github-bootstrap"]?.environment as { name: string }).name, "admin-ops");
  assert.equal((jobs["worker-publish"]?.environment as { name: string }).name, "ai-gateway-ops");
  assert.equal(jobs["github-bootstrap"]?.needs, "worker-preflight");
  assert.equal(jobs["worker-publish"]?.needs, "github-bootstrap");

  const steps = jobs["github-bootstrap"]?.steps as { env?: Record<string, string> }[];
  assert.ok(steps.some((step) => step.env?.GH_TOKEN === "${{ secrets.AW_ADMIN_TOKEN }}"));
  const script = readFileSync("scripts/bootstrap-ai-gateway-health-key.ts", "utf8");
  assert.match(script, /randomBytes\(32\)\.toString\("hex"\)/);
  assert.match(script, /input: value/);
  assert.match(script, /assertHealthKeyIsUninitialized\(\[\], githubNames\)/);
  assert.match(script, /assertHealthKeyIsUninitialized\(names, \[\[\], \[\]\]\)/);
  assert.match(script, /putWorkerSecret\(/);
});
