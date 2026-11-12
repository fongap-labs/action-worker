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
    AW_CLOUDFLARE_ACCOUNT_ID_SECONDARY: account,
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
  const expected = { ...input, CLOUDFLARE_ACCOUNT_ID_SECONDARY: account, AIG_PUBLIC_URL: "https://gateway.example" };
  delete (expected as Partial<typeof input>).SOME_UNRELATED_CONTROL_VARIABLE;
  assert.deepEqual(validateGatewayOpsVariables(input), expected);
  assert.deepEqual(decodeGatewayOpsVariables(encodeGatewayOpsVariables(input)), expected);
  assert.equal(isGatewayOwnedVariableName("AIG_MODELS_CONFIG"), true);
  assert.equal(isGatewayOwnedVariableName("AW_CLOUDFLARE_ACCOUNT_ID_SECONDARY"), true);
  assert.equal(isGatewayOwnedVariableName("CLOUDFLARE_ACCOUNT_ID_SECONDARY"), true);
  assert.equal(isGatewayOwnedVariableName("SOME_UNRELATED_CONTROL_VARIABLE"), false);
});

test("bootstrap metadata ignores inherited retired settings without weakening deployment checks", () => {
  const inherited = {
    AW_CLOUDFLARE_ACCOUNT_ID_SECONDARY: account,
    AIG_PUBLIC_URL: "https://gateway.example/",
    AIG_OAUTH_ADMIN_GROUPS: "MAX,ULTRA",
    AIG_TIER3_NODES_01: "[]",
    SOME_UNRELATED_VARIABLE: "other",
  };
  assert.deepEqual(validateGatewayBootstrapMetadata(inherited), {
    AW_CLOUDFLARE_ACCOUNT_ID_SECONDARY: account,
    CLOUDFLARE_ACCOUNT_ID_SECONDARY: account,
    AIG_PUBLIC_URL: "https://gateway.example",
  });
  assert.throws(() => validateGatewayOpsVariables(inherited), /retired/);
  assert.throws(
    () =>
      validateGatewayBootstrapMetadata({ ...inherited, AW_CLOUDFLARE_ACCOUNT_ID_SECONDARY: "bad" }),
    /invalid/
  );
});

test("missing identity, malformed metadata, Secrets, retired and derived Variables fail closed", () => {
  for (const invalid of [
    {},
    { AW_CLOUDFLARE_ACCOUNT_ID_SECONDARY: "invalid" },
    { AW_CLOUDFLARE_ACCOUNT_ID_SECONDARY: account, AIG_PUBLIC_URL: "http://gateway.example" },
    {
      AW_CLOUDFLARE_ACCOUNT_ID_SECONDARY: account,
      AIG_PUBLIC_URL: "https://user:pass@gateway.example",
    },
    { AW_CLOUDFLARE_ACCOUNT_ID_SECONDARY: account, AIG_PUBLIC_URL: "https://gateway.example/path" },
    { AW_CLOUDFLARE_ACCOUNT_ID_SECONDARY: account, AIG_AFFINITY_KV_ID: "bad" },
    { AW_CLOUDFLARE_ACCOUNT_ID_SECONDARY: account, AIG_USAGE_D1_ID: "bad" },
    { AW_CLOUDFLARE_ACCOUNT_ID_SECONDARY: account, AIG_ANALYTICS_DATASET: "invalid-value" },
    { AW_CLOUDFLARE_ACCOUNT_ID_SECONDARY: account, AIG_INFERENCE_TARGET: "Invalid_Service" },
    { AW_CLOUDFLARE_ACCOUNT_ID_SECONDARY: account, AIG_TIER1_NODES_1: "[]" },
    { AW_CLOUDFLARE_ACCOUNT_ID_SECONDARY: account, AIG_ACCESS_MODELS_: "*" },
    { AW_CLOUDFLARE_ACCOUNT_ID_SECONDARY: account, AIG_ACCESS_KEY_AGENT: "secret" },
    { AW_CLOUDFLARE_ACCOUNT_ID_SECONDARY: account, AIG_PROVIDER_API_KEY: "secret" },
    { AW_CLOUDFLARE_ACCOUNT_ID_SECONDARY: account, AIG_ARCHIVE_SECRET: "secret" },
    { AW_CLOUDFLARE_ACCOUNT_ID_SECONDARY: account, AIG_RUNTIME_ACCESS_TOKEN: "secret" },
    { AW_CLOUDFLARE_ACCOUNT_ID_SECONDARY: account, AIG_TIER1_CREDENTIALS_01: "secret" },
    { AW_CLOUDFLARE_ACCOUNT_ID_SECONDARY: account, CLOUDFLARE_API_TOKEN_OPS: "secret" },
    { AW_CLOUDFLARE_ACCOUNT_ID_SECONDARY: account, AIG_TIER3_NODES_01: "[]" },
    { AW_CLOUDFLARE_ACCOUNT_ID_SECONDARY: account, AIG_OAUTH_PROVIDERS: "[]" },
    { AW_CLOUDFLARE_ACCOUNT_ID_SECONDARY: account, AIG_IS_SUBSCRIPTION_ENABLED: "false" },
    { AW_CLOUDFLARE_ACCOUNT_ID_SECONDARY: account, AIG_BUILD_SHA: "configured" },
    { AW_CLOUDFLARE_ACCOUNT_ID_SECONDARY: account, AIG_INFERENCE_SERVICE: "configured" },
  ]) {
    assert.throws(
      () => validateGatewayOpsVariables(invalid),
      /invalid|unavailable|HTTPS origin|valid Worker|stored as a Secret|retired|derived|01 through 10|group suffix/
    );
  }
  assert.throws(() => decodeGatewayOpsVariables("not+base64"), /encoding is invalid/);
});

test("deployment workflow uses repository-only Gateway Variables without inheriting ops values", () => {
  const workflow = parse(readFileSync(".github/workflows/deploy-source-script.yml", "utf8")) as {
    jobs: Record<string, Record<string, unknown>>;
  };
  const ops = workflow.jobs.gateway_variables;
  const deploy = workflow.jobs.deploy;
  assert.ok(ops && deploy);
  assert.equal(ops.environment, undefined, "repository Variable read must not inherit the ops Environment");
  assert.deepEqual(ops.outputs, {
    variables_b64: "${{ steps.variables.outputs.variables_b64 }}",
  });
  const steps = ops.steps as Array<{ name: string; env?: Record<string, string>; run?: string }>;
  assert.equal(steps.at(-1)?.run, "node scripts/read-gateway-repository-variables.ts");
  assert.deepEqual(steps.at(-1)?.env, { GITHUB_TOKEN: "${{ steps.repository_variables_app.outputs.token }}" });
  const exportStep = (deploy.steps as Array<{ name: string; env?: Record<string, string> }>).find(
    (step) => step.name === "Export scoped deployment variables"
  );
  assert.deepEqual(exportStep?.env, {
    REPOSITORY_VARS_JSON:
      "${{ needs.prepare.outputs.source_repository == 'fongap-labs/ai-gateway' && '{}' || toJSON(vars) }}",
    AW_GATEWAY_VARIABLES_B64_FROM_REPOSITORY: "${{ needs.gateway_variables.outputs.variables_b64 }}",
    DEPLOY_CREDENTIAL_ENVIRONMENT: "${{ needs.prepare.outputs.credential_environment }}",
  });
  assert.doesNotMatch(JSON.stringify(ops.outputs), /API_TOKEN|HEALTH_KEY|SECRET/);
});
