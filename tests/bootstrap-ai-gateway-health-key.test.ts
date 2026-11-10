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

test("bootstrap cannot overwrite Cloudflare or the credential-owning ops Environment", () => {
  assert.doesNotThrow(() =>
    assertHealthKeyIsUninitialized(["SOME_OTHER_KEY"], [["CLOUDFLARE_API_TOKEN"]])
  );
  assert.throws(
    () => assertHealthKeyIsUninitialized(["AIG_DEPLOY_HEALTH_KEY"], [[]]),
    /refusing to rotate/
  );
  assert.throws(
    () => assertHealthKeyIsUninitialized([], [["AIG_DEPLOY_HEALTH_KEY"]]),
    /refusing to rotate/
  );
  assert.throws(() => assertHealthKeyIsUninitialized([], []), /incomplete/);
  assert.throws(() => assertHealthKeyIsUninitialized([], [[], []]), /incomplete/);
});

test("one-shot bootstrap reuses existing deploy Secrets with ops-only non-secret metadata", () => {
  const workflow = parse(
    readFileSync(".github/workflows/bootstrap-health-key.yml", "utf8")
  ) as Record<string, unknown>;
  const trigger = workflow.on as { push: { branches: string[]; paths: string[] } };
  assert.deepEqual(trigger.push.branches, ["main"]);
  assert.deepEqual(trigger.push.paths, ["policies/ai-gateway-health-bootstrap.request"]);
  const jobs = workflow.jobs as Record<string, Record<string, unknown>>;
  assert.deepEqual(Object.keys(jobs), [
    "gateway_metadata",
    "worker-preflight",
    "github-bootstrap",
    "worker-publish",
  ]);
  const metadata = jobs.gateway_metadata;
  const preflight = jobs["worker-preflight"];
  const github = jobs["github-bootstrap"];
  const publish = jobs["worker-publish"];
  assert.ok(metadata && preflight && github && publish);
  assert.equal((metadata.environment as { name: string }).name, "ai-gateway-ops");
  assert.equal((preflight.environment as { name: string }).name, "production");
  assert.equal((github.environment as { name: string }).name, "admin-ops");
  assert.equal((publish.environment as { name: string }).name, "production");
  assert.equal(preflight.needs, "gateway_metadata");
  assert.equal(github.needs, "worker-preflight");
  assert.deepEqual(publish.needs, ["github-bootstrap", "gateway_metadata"]);
  assert.deepEqual(metadata.outputs, {
    account_id: "${{ steps.metadata.outputs.account_id }}",
    public_url: "${{ steps.metadata.outputs.public_url }}",
  });
  const metadataSteps = metadata.steps as {
    name?: string;
    env?: Record<string, string>;
    run?: string;
  }[];
  const exportStep = metadataSteps.find(
    (step) => step.name === "Validate approved Gateway ops metadata"
  );
  assert.deepEqual(exportStep?.env, { AIG_OPS_VARIABLES_JSON: "${{ toJSON(vars) }}" });
  assert.equal(exportStep?.run, "node scripts/gateway-ops-variables.ts");
  assert.ok(
    metadataSteps.some(
      (step) =>
        step.name === "Require configured public health origin" &&
        step.env?.AIG_PUBLIC_URL === "${{ steps.metadata.outputs.public_url }}"
    )
  );
  assert.doesNotMatch(JSON.stringify(metadata), /secrets\./);

  const bootstrapSteps = github.steps as { env?: Record<string, string> }[];
  assert.ok(bootstrapSteps.some((step) => step.env?.GH_TOKEN === "${{ secrets.AW_ADMIN_TOKEN }}"));
  for (const job of [preflight, publish]) {
    const steps = job.steps as { env?: Record<string, string> }[];
    const deployEnv = steps.find((step) => step.env?.CLOUDFLARE_API_TOKEN_OPS);
    assert.equal(
      deployEnv?.env?.CLOUDFLARE_API_TOKEN_OPS,
      "${{ secrets.CLOUDFLARE_API_TOKEN_SECONDARY }}"
    );
    assert.equal(
      deployEnv?.env?.CLOUDFLARE_ACCOUNT_ID_OPS,
      "${{ needs.gateway_metadata.outputs.account_id }}"
    );
  }
  const publishSteps = publish.steps as { env?: Record<string, string> }[];
  assert.equal(
    publishSteps.find((step) => step.env?.AIG_DEPLOY_HEALTH_KEY)?.env?.AIG_PUBLIC_URL,
    "${{ needs.gateway_metadata.outputs.public_url }}"
  );
  const script = readFileSync("scripts/bootstrap-ai-gateway-health-key.ts", "utf8");
  assert.match(script, /const environments = \["production"\]/);
  assert.match(script, /randomBytes\(32\)\.toString\("hex"\)/);
  assert.match(script, /input: value/);
  assert.match(script, /assertHealthKeyIsUninitialized\(\[\], githubNames\)/);
  assert.match(script, /assertHealthKeyIsUninitialized\(names, \[\[\]\]\)/);
  assert.match(script, /putWorkerSecret\(/);
});
