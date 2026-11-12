import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";
import {
  decodeGatewayOpsVariables,
  encodeGatewayOpsVariables,
  isGatewayOwnedVariableName,
  validateGatewayBootstrapMetadata,
  validateGatewayOpsVariables,
} from "../scripts/gateway-ops-variables.ts";

const account = "0123456789abcdef0123456789abcdef";
const kv = "11111111111111111111111111111111";
const d1 = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

test("complete non-sensitive Gateway ops Variables are validated without hardcoded models", () => {
  const input = {
    CLOUDFLARE_ACCOUNT_ID_SECONDARY: account,
    AIG_PUBLIC_URL: "https://gateway.example/",
    AIG_AFFINITY_KV_ID: kv,
    AIG_USAGE_D1_ID: d1,
    AIG_ANALYTICS_DATASET: "GATEWAY_EVENTS",
    AIG_INFERENCE_TARGET: "ai-inference-center",
    AIG_GENERATION_TARGET: "ai-generation-center",
    AIG_TIER1_NODES_01: JSON.stringify([{ model: "configured-at-runtime" }]),
    AIG_ACCESS_MODELS_AGENT: "configured-at-runtime",
    AIG_MODELS_CONFIG: JSON.stringify({ catalog: ["configured-at-runtime"] }),
    SOME_UNRELATED_CONTROL_VARIABLE: "ignored",
  };
  const expected = {
    ...input,
    AIG_PUBLIC_URL: "https://gateway.example",
  };
  delete (expected as Partial<typeof input>).SOME_UNRELATED_CONTROL_VARIABLE;
  assert.deepEqual(validateGatewayOpsVariables(input), expected);
  assert.deepEqual(decodeGatewayOpsVariables(encodeGatewayOpsVariables(input)), expected);
  assert.equal(isGatewayOwnedVariableName("AIG_MODELS_CONFIG"), true);
  assert.equal(isGatewayOwnedVariableName("CLOUDFLARE_ACCOUNT_ID_SECONDARY"), true);
  assert.equal(isGatewayOwnedVariableName("CLOUDFLARE_ACCOUNT_ID_REPOSITORY"), false);
  assert.equal(isGatewayOwnedVariableName("SOME_UNRELATED_CONTROL_VARIABLE"), false);
});

test("bootstrap metadata ignores inherited retired settings without weakening deployment checks", () => {
  const inherited = {
    CLOUDFLARE_ACCOUNT_ID_SECONDARY: account,
    AIG_PUBLIC_URL: "https://gateway.example/",
    AIG_OAUTH_ADMIN_GROUPS: "MAX,ULTRA",
    AIG_TIER3_NODES_01: "[]",
    SOME_UNRELATED_VARIABLE: "other",
  };
  assert.deepEqual(validateGatewayBootstrapMetadata(inherited), {
    CLOUDFLARE_ACCOUNT_ID_SECONDARY: account,
    AIG_PUBLIC_URL: "https://gateway.example",
  });
  assert.throws(() => validateGatewayOpsVariables(inherited), /retired/);
  assert.throws(
    () =>
      validateGatewayBootstrapMetadata({ ...inherited, CLOUDFLARE_ACCOUNT_ID_SECONDARY: "bad" }),
    /invalid/
  );
});

test("missing identity, malformed metadata, Secrets, retired and derived Variables fail closed", () => {
  for (const invalid of [
    {},
    { CLOUDFLARE_ACCOUNT_ID_SECONDARY: "invalid" },
    { CLOUDFLARE_ACCOUNT_ID_SECONDARY: account, AIG_PUBLIC_URL: "http://gateway.example" },
    {
      CLOUDFLARE_ACCOUNT_ID_SECONDARY: account,
      AIG_PUBLIC_URL: "https://user:pass@gateway.example",
    },
    { CLOUDFLARE_ACCOUNT_ID_SECONDARY: account, AIG_PUBLIC_URL: "https://gateway.example/path" },
    { CLOUDFLARE_ACCOUNT_ID_SECONDARY: account, AIG_AFFINITY_KV_ID: "bad" },
    { CLOUDFLARE_ACCOUNT_ID_SECONDARY: account, AIG_USAGE_D1_ID: "bad" },
    { CLOUDFLARE_ACCOUNT_ID_SECONDARY: account, AIG_ANALYTICS_DATASET: "invalid-value" },
    { CLOUDFLARE_ACCOUNT_ID_SECONDARY: account, AIG_INFERENCE_TARGET: "Invalid_Service" },
    { CLOUDFLARE_ACCOUNT_ID_SECONDARY: account, AIG_TIER1_NODES_1: "[]" },
    { CLOUDFLARE_ACCOUNT_ID_SECONDARY: account, AIG_ACCESS_MODELS_: "*" },
    { CLOUDFLARE_ACCOUNT_ID_SECONDARY: account, AIG_ACCESS_KEY_AGENT: "secret" },
    { CLOUDFLARE_ACCOUNT_ID_SECONDARY: account, AIG_PROVIDER_API_KEY: "secret" },
    { CLOUDFLARE_ACCOUNT_ID_SECONDARY: account, AIG_ARCHIVE_SECRET: "secret" },
    { CLOUDFLARE_ACCOUNT_ID_SECONDARY: account, AIG_RUNTIME_ACCESS_TOKEN: "secret" },
    { CLOUDFLARE_ACCOUNT_ID_SECONDARY: account, AIG_TIER1_CREDENTIALS_01: "secret" },
    { CLOUDFLARE_ACCOUNT_ID_SECONDARY: account, CLOUDFLARE_API_TOKEN_OPS: "secret" },
    { CLOUDFLARE_ACCOUNT_ID_SECONDARY: account, AIG_TIER3_NODES_01: "[]" },
    { CLOUDFLARE_ACCOUNT_ID_SECONDARY: account, AIG_OAUTH_PROVIDERS: "[]" },
    { CLOUDFLARE_ACCOUNT_ID_SECONDARY: account, AIG_IS_SUBSCRIPTION_ENABLED: "false" },
    { CLOUDFLARE_ACCOUNT_ID_SECONDARY: account, AIG_BUILD_SHA: "configured" },
    { CLOUDFLARE_ACCOUNT_ID_SECONDARY: account, AIG_INFERENCE_SERVICE: "configured" },
  ]) {
    assert.throws(
      () => validateGatewayOpsVariables(invalid),
      /invalid|unavailable|HTTPS origin|valid Worker|stored as a Secret|retired|derived|01 through 10|group suffix/
    );
  }
  assert.throws(() => decodeGatewayOpsVariables("not+base64"), /encoding is invalid/);
});

test("deployment workflow reads ops runtime Variables and repository Cloudflare metadata", () => {
  const workflow = parse(readFileSync(".github/workflows/deploy-source-script.yml", "utf8")) as {
    jobs: Record<string, Record<string, unknown>>;
  };
  const ops = workflow.jobs.gateway_variables;
  const deploy = workflow.jobs.deploy;
  assert.ok(ops && deploy);
  assert.equal(
    ops.environment,
    undefined,
    "repository Variable read must not inherit the ops Environment"
  );
  assert.deepEqual(ops.outputs, {
    variables_b64: "${{ steps.variables.outputs.variables_b64 }}",
    cloudflare_nonce: "${{ steps.cloudflare_secret.outputs.nonce }}",
    cloudflare_proof: "${{ steps.cloudflare_secret.outputs.proof }}",
  });
  const steps = ops.steps as Array<{ name: string; env?: Record<string, string>; run?: string }>;
  assert.equal(steps.at(-1)?.run, "node scripts/gateway-repository-vars.ts");
  assert.deepEqual(steps.at(-1)?.env, {
    AW_APP_CLIENT_ID: "${{ vars.AW_APP_CLIENT_ID }}",
    AW_APP_PRIVATE_KEY: "${{ secrets.AW_APP_PRIVATE_KEY }}",
  });
  const exportStep = (deploy.steps as Array<{ name: string; env?: Record<string, string> }>).find(
    (step) => step.name === "Export scoped deployment variables"
  );
  assert.deepEqual(exportStep?.env, {
    REPOSITORY_VARS_JSON: "${{ toJSON(vars) }}",
    AW_GATEWAY_VARIABLES_B64_FROM_REPOSITORY:
      "${{ needs.gateway_variables.outputs.variables_b64 }}",
    DEPLOY_CREDENTIAL_ENVIRONMENT: "${{ needs.prepare.outputs.credential_environment }}",
  });
  assert.doesNotMatch(JSON.stringify(ops.outputs), /API_TOKEN|HEALTH_KEY|SECRET/);
});
