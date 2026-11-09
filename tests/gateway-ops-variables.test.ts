import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";
import { validateGatewayOpsVariables } from "../scripts/gateway-ops-variables.ts";

const account = "0123456789abcdef0123456789abcdef";
const kv = "11111111111111111111111111111111";
const d1 = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

test("only allowlisted non-sensitive Gateway ops Variables are exported", () => {
  assert.deepEqual(
    validateGatewayOpsVariables({
      CLOUDFLARE_ACCOUNT_ID_SECONDARY: account,
      AIG_PUBLIC_URL: "https://gateway.example/",
      AIG_AFFINITY_KV_ID: kv,
      AIG_USAGE_D1_ID: d1,
      AIG_ANALYTICS_DATASET: "GATEWAY_EVENTS",
      CLOUDFLARE_API_TOKEN_OPS: "must-never-be-exported",
      AIG_DEPLOY_HEALTH_KEY: "must-never-be-exported",
      SOME_UNREVIEWED_VARIABLE: "must-never-be-exported",
    }),
    {
      CLOUDFLARE_ACCOUNT_ID_SECONDARY: account,
      AIG_PUBLIC_URL: "https://gateway.example",
      AIG_AFFINITY_KV_ID: kv,
      AIG_USAGE_D1_ID: d1,
      AIG_ANALYTICS_DATASET: "GATEWAY_EVENTS",
    }
  );
  assert.deepEqual(validateGatewayOpsVariables({ CLOUDFLARE_ACCOUNT_ID_SECONDARY: account }), {
    CLOUDFLARE_ACCOUNT_ID_SECONDARY: account,
  });
});

test("missing account or invalid optional ops metadata always fails closed", () => {
  for (const invalid of [
    {},
    { CLOUDFLARE_ACCOUNT_ID_SECONDARY: "invalid" },
    { CLOUDFLARE_ACCOUNT_ID_SECONDARY: account, AIG_PUBLIC_URL: "http://gateway.example" },
    {
      CLOUDFLARE_ACCOUNT_ID_SECONDARY: account,
      AIG_PUBLIC_URL: "https://user:pass@gateway.example",
    },
    { CLOUDFLARE_ACCOUNT_ID_SECONDARY: account, AIG_PUBLIC_URL: "https://gateway.example/path" },
    {
      CLOUDFLARE_ACCOUNT_ID_SECONDARY: account,
      AIG_PUBLIC_URL: "https://gateway.example\nbad=value",
    },
    { CLOUDFLARE_ACCOUNT_ID_SECONDARY: account, AIG_AFFINITY_KV_ID: "bad" },
    { CLOUDFLARE_ACCOUNT_ID_SECONDARY: account, AIG_USAGE_D1_ID: "bad" },
    { CLOUDFLARE_ACCOUNT_ID_SECONDARY: account, AIG_ANALYTICS_DATASET: "invalid-value" },
  ]) {
    assert.throws(
      () => validateGatewayOpsVariables(invalid),
      /invalid|missing|unavailable|HTTPS origin/
    );
  }
});

test("deployment workflow requires protected ops and uses only approved identifiers as outputs", () => {
  const workflow = parse(readFileSync(".github/workflows/deploy-source-script.yml", "utf8")) as {
    jobs: Record<string, Record<string, unknown>>;
  };
  const ops = workflow.jobs.gateway_account_id;
  const deploy = workflow.jobs.deploy;
  assert.ok(ops && deploy);
  assert.deepEqual(ops.environment, { name: "ai-gateway-ops", deployment: false });
  const steps = ops.steps as Array<{ name: string; env?: Record<string, string>; run?: string }>;
  assert.equal(steps.at(-1)?.run, "node scripts/gateway-ops-variables.ts");
  const env = steps.at(-1)?.env ?? {};
  assert.deepEqual(Object.keys(env).sort(), [
    "AIG_AFFINITY_KV_ID",
    "AIG_ANALYTICS_DATASET",
    "AIG_PUBLIC_URL",
    "AIG_USAGE_D1_ID",
    "CLOUDFLARE_ACCOUNT_ID_SECONDARY",
  ]);
  assert.equal(
    (ops.outputs as Record<string, unknown>).public_url,
    "${{ steps.account_id.outputs.public_url }}"
  );
  const exportStep = (deploy.steps as Array<{ name: string; env?: Record<string, string> }>).find(
    (step) => step.name === "Export repository variables"
  );
  assert.equal(
    exportStep?.env?.AW_GATEWAY_PUBLIC_URL_FROM_OPS,
    "${{ needs.gateway_account_id.outputs.public_url }}"
  );
  assert.equal(
    exportStep?.env?.AW_GATEWAY_USAGE_D1_ID_FROM_OPS,
    "${{ needs.gateway_account_id.outputs.usage_d1_id }}"
  );
  assert.equal(
    exportStep?.env?.AW_GATEWAY_AFFINITY_KV_ID_FROM_OPS,
    "${{ needs.gateway_account_id.outputs.affinity_kv_id }}"
  );
  assert.equal(
    exportStep?.env?.AW_GATEWAY_ANALYTICS_DATASET_FROM_OPS,
    "${{ needs.gateway_account_id.outputs.analytics_dataset }}"
  );
  assert.doesNotMatch(JSON.stringify(ops.outputs), /API_TOKEN|HEALTH_KEY|SECRET/);
});
