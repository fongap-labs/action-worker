import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";
import { mergeApprovedGatewayOpsVariables } from "../scripts/export-repository-variables.ts";
import {
  readDeploySecretCeiling,
  readDeploySecretVariableSources,
  readSecretAliases,
  resolveDeploySecretPlan,
} from "../scripts/resolve-secret-scope.ts";
import {
  buildScopedDeployEnvironment,
  loadScopedSecretValues,
} from "../scripts/run-scoped-deploy.ts";
import { stageDeploySecretSlots } from "../scripts/stage-deploy-secret-bundle.ts";

test("deploy plan separates existing Secrets from explicit Repository Variables", async () => {
  const root = await mkdtemp(join(tmpdir(), "deploy-plan-"));
  try {
    const required = join(root, "required");
    const allowed = join(root, "allowed");
    const policy = join(root, "policy.json");
    await writeFile(required, "TOKEN_REQUIRED\nACCOUNT_ID\n");
    await writeFile(allowed, "TOKEN_OPTIONAL\n");
    await writeFile(
      policy,
      JSON.stringify({
        schema_version: 1,
        deployments: {
          "owner/repo": {
            production: {
              required: ["TOKEN_REQUIRED", "ACCOUNT_ID"],
              allowed: ["TOKEN_OPTIONAL"],
              aliases: { ACCOUNT_ID: "ACCOUNT_ID_VARIABLE" },
              variable_sources: ["ACCOUNT_ID_VARIABLE"],
            },
          },
        },
      })
    );
    const sources = await readDeploySecretVariableSources(policy, "owner/repo", "production");
    assert.deepEqual([...sources], ["ACCOUNT_ID_VARIABLE"]);
    const plan = await resolveDeploySecretPlan(
      required,
      allowed,
      policy,
      "owner/repo",
      "production",
      "",
      { PATH: "/usr/bin", ACCOUNT_ID_VARIABLE: "account-id" }
    );
    assert.deepEqual(plan, [
      {
        name: "ACCOUNT_ID",
        source: "ACCOUNT_ID_VARIABLE",
        required: true,
        kind: "variable",
      },
      {
        name: "TOKEN_OPTIONAL",
        source: "TOKEN_OPTIONAL",
        required: false,
        kind: "secret",
      },
      {
        name: "TOKEN_REQUIRED",
        source: "TOKEN_REQUIRED",
        required: true,
        kind: "secret",
      },
    ]);
    await assert.rejects(
      resolveDeploySecretPlan(required, allowed, policy, "owner/repo", "production", "", {
        PATH: "/usr/bin",
      }),
      /Required deploy variable is unavailable: ACCOUNT_ID/
    );
    await writeFile(allowed, "UNAUTHORIZED_SECRET\n");
    await assert.rejects(
      resolveDeploySecretPlan(required, allowed, policy, "owner/repo", "production", "", {
        PATH: "/usr/bin",
        ACCOUNT_ID_VARIABLE: "available",
      }),
      /outside the central deploy secret policy: UNAUTHORIZED_SECRET/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("shipped product ceilings remain isolated and require independent AI Gateway health key", async () => {
  const policyPath = "policies/deploy-secrets.json";
  const ai = await readDeploySecretCeiling(policyPath, "fongap-labs/ai-gateway", "production");
  assert.deepEqual([...ai].sort(), [
    "AIG_DEPLOY_HEALTH_KEY",
    "CLOUDFLARE_ACCOUNT_ID",
    "CLOUDFLARE_API_TOKEN",
  ]);
  const aliases = await readSecretAliases(
    policyPath,
    "deploy",
    "fongap-labs/ai-gateway",
    "production"
  );
  assert.equal(aliases.has("AIG_DEPLOY_HEALTH_KEY"), false);
  assert.equal(aliases.get("CLOUDFLARE_API_TOKEN"), "CLOUDFLARE_API_TOKEN_SECONDARY");
  assert.deepEqual(
    [
      ...(await readDeploySecretVariableSources(
        policyPath,
        "fongap-labs/ai-gateway",
        "production"
      )),
    ],
    ["CLOUDFLARE_ACCOUNT_ID_SECONDARY"]
  );
  const mcp = await readDeploySecretCeiling(policyPath, "fongap-labs/mcp-hub", "production");
  assert.deepEqual([...mcp], ["CLOUDFLARE_API_TOKEN_SECONDARY"]);
  const edge = await readDeploySecretCeiling(
    policyPath,
    "fongap-labs/internal-vault",
    "production",
    "server-edge"
  );
  assert.equal(edge.size, 4);
});

test("staged individual Secrets are private and never include unselected slots", async () => {
  const root = await mkdtemp(join(tmpdir(), "deploy-stage-"));
  try {
    const plan = {
      schema_version: 1 as const,
      secrets: [
        { name: "TOKEN_A", source: "TOKEN_STORED_A", required: true, kind: "secret" as const },
        { name: "TOKEN_B", source: "TOKEN_STORED_B", required: false, kind: "secret" as const },
      ],
    };
    const staged = await stageDeploySecretSlots(
      { AW_DEPLOY_SECRET_00: "test-a", AW_DEPLOY_SECRET_01: "", AW_DEPLOY_SECRET_02: "ignored" },
      plan,
      root
    );
    assert.deepEqual(staged, ["TOKEN_A"]);
    const path = join(root, "action-worker-deploy-secrets", "TOKEN_A");
    const info = await lstat(path);
    assert.equal(info.mode & 0o077, 0);
    assert.equal(await readFile(path, "utf8"), "test-a");
    const values = await loadScopedSecretValues(join(root, "action-worker-deploy-secrets"), plan);
    assert.deepEqual([...values], [["TOKEN_A", "test-a"]]);
    await writeFile(join(root, "action-worker-deploy-secrets", "OTHER"), "no");
    await assert.rejects(
      loadScopedSecretValues(join(root, "action-worker-deploy-secrets"), plan),
      /Unexpected staged Secret file/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("source deployment environment excludes other product and control-plane credentials", () => {
  const plan = {
    schema_version: 1 as const,
    secrets: [
      {
        name: "CLOUDFLARE_API_TOKEN",
        source: "CLOUDFLARE_API_TOKEN_SECONDARY",
        required: true,
        kind: "secret" as const,
      },
      {
        name: "CLOUDFLARE_ACCOUNT_ID",
        source: "CLOUDFLARE_ACCOUNT_ID_SECONDARY",
        required: true,
        kind: "variable" as const,
      },
      {
        name: "OPTIONAL_TOKEN",
        source: "OPTIONAL_TOKEN",
        required: false,
        kind: "secret" as const,
      },
    ],
  };
  const base = {
    PATH: "/usr/bin",
    DEPLOY_SOURCE_REPOSITORY: "owner/repo",
    AW_CONTROL_TOKEN: "control",
    AW_CHECKOUT_TOKEN: "checkout",
    GH_TOKEN: "github",
    NODE_OPTIONS: "--require injected.js",
    OTHER_SECRET: "unrelated",
    GITHUB_OUTPUT: "/tmp/output",
  };
  const environment = buildScopedDeployEnvironment(
    base,
    plan,
    new Map([["CLOUDFLARE_API_TOKEN", "deploy-token"]]),
    { CLOUDFLARE_ACCOUNT_ID_SECONDARY: "account-id", PUBLIC_URL: "https://example.test" }
  );
  assert.equal(environment.PATH, "/usr/bin");
  assert.equal(environment.DEPLOY_SOURCE_REPOSITORY, "owner/repo");
  assert.equal(environment.CLOUDFLARE_API_TOKEN, "deploy-token");
  assert.equal(environment.CLOUDFLARE_ACCOUNT_ID, "account-id");
  assert.equal(environment.PUBLIC_URL, "https://example.test");
  for (const name of [
    "AW_CONTROL_TOKEN",
    "AW_CHECKOUT_TOKEN",
    "GH_TOKEN",
    "NODE_OPTIONS",
    "OTHER_SECRET",
    "GITHUB_OUTPUT",
    "CLOUDFLARE_ACCOUNT_ID_SECONDARY",
    "OPTIONAL_TOKEN",
  ]) {
    assert.equal(environment[name], undefined, name);
  }
});

test("workflow resolves one source per fixed slot without embedding product Secret names", async () => {
  const source = await readFile(".github/workflows/deploy-source-script.yml", "utf8");
  const workflow = parse(source) as {
    jobs: Record<
      string,
      { steps?: Array<{ name?: string; env?: Record<string, string>; run?: string }> }
    >;
  };
  const steps = workflow.jobs.deploy?.steps ?? [];
  const plan = steps.find((step) => step.name === "Resolve deploy Secret plan");
  const stage = steps.find((step) => step.name === "Stage authorized deployment Secrets");
  const execute = steps.find((step) => step.name === "Execute source-owned deploy entrypoint");
  assert.match(plan?.run ?? "", /resolve-deploy-secret-plan\.ts/);
  assert.match(execute?.run ?? "", /run-scoped-deploy\.ts/);
  assert.equal(execute?.env, undefined);
  const names = Object.keys(stage?.env ?? {});
  assert.equal(names.length, 40);
  assert.equal(names[0], "AW_DEPLOY_SECRET_00");
  assert.equal(names[39], "AW_DEPLOY_SECRET_39");
  for (const [index, name] of names.entries()) {
    const slot = String(index).padStart(2, "0");
    assert.equal(name, `AW_DEPLOY_SECRET_${slot}`);
    assert.equal(
      stage?.env?.[name],
      "$" + `{{ secrets[steps.secret_plan.outputs.secret_${slot}] }}`
    );
  }
  assert.equal(stage?.run, "node control/scripts/stage-deploy-secret-bundle.ts");
  assert.equal(source.includes("env: $" + "{{ secrets }}"), false);
  for (const name of ["AIG_ACCESS_KEY_AGENT", "SERVER_EDGE_SECRET_BUNDLE", "MCP_RUNTIME_KEY"]) {
    assert.equal(source.includes("secrets." + name), false, name);
  }
});

test("AI Gateway production imports its complete non-sensitive snapshot only from protected ops", () => {
  const account = "0123456789abcdef0123456789abcdef";
  const kv = "11111111111111111111111111111111";
  const d1 = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const approved = {
    CLOUDFLARE_ACCOUNT_ID_SECONDARY: account,
    AIG_PUBLIC_URL: "https://gateway.example/",
    AIG_AFFINITY_KV_ID: kv,
    AIG_USAGE_D1_ID: d1,
    AIG_ANALYTICS_DATASET: "GATEWAY_EVENTS",
    AIG_MODELS_CONFIG: JSON.stringify({ catalog: ["configured-at-runtime"] }),
    AIG_ACCESS_MODELS_AGENT: "configured-at-runtime",
  };
  assert.deepEqual(
    mergeApprovedGatewayOpsVariables(
      { PUBLIC_VALUE: "unchanged" },
      "fongap-labs/ai-gateway",
      "production",
      approved
    ),
    {
      CLOUDFLARE_ACCOUNT_ID_SECONDARY: account,
      AIG_PUBLIC_URL: "https://gateway.example",
      AIG_AFFINITY_KV_ID: kv,
      AIG_USAGE_D1_ID: d1,
      AIG_ANALYTICS_DATASET: "GATEWAY_EVENTS",
      AIG_MODELS_CONFIG: JSON.stringify({ catalog: ["configured-at-runtime"] }),
      AIG_ACCESS_MODELS_AGENT: "configured-at-runtime",
      PUBLIC_VALUE: "unchanged",
    }
  );
  const misplacedSources: Array<Record<string, string>> = [
    { AIG_PUBLIC_URL: "https://gateway.example" },
    { AIG_MODELS_CONFIG: approved.AIG_MODELS_CONFIG },
    { CLOUDFLARE_ACCOUNT_ID_SECONDARY: account },
  ];
  for (const misplaced of misplacedSources) {
    assert.throws(
      () =>
        mergeApprovedGatewayOpsVariables(
          misplaced,
          "fongap-labs/ai-gateway",
          "production",
          approved
        ),
      /must exist only in protected ai-gateway-ops/
    );
  }
  assert.deepEqual(
    mergeApprovedGatewayOpsVariables(
      { PUBLIC_URL: "https://example.test" },
      "fongap-labs/mcp-hub",
      "production",
      {}
    ),
    { PUBLIC_URL: "https://example.test" }
  );
  assert.throws(
    () => mergeApprovedGatewayOpsVariables({}, "fongap-labs/mcp-hub", "production", approved),
    /not authorized/
  );
  assert.throws(
    () => mergeApprovedGatewayOpsVariables({}, "fongap-labs/ai-gateway", "staging", approved),
    /not authorized/
  );
});

test("AI Gateway Variables are read only in the protected ops job", async () => {
  const source = await readFile(".github/workflows/deploy-source-script.yml", "utf8");
  const workflow = parse(source) as { jobs: Record<string, Record<string, unknown>> };
  const variableJob = workflow.jobs.gateway_variables;
  const deploy = workflow.jobs.deploy;
  assert.ok(variableJob && deploy);
  assert.deepEqual(variableJob.environment, { name: "ai-gateway-ops", deployment: false });
  const variableSteps = variableJob.steps as Array<{ env?: Record<string, string> }>;
  assert.equal(variableSteps.at(-1)?.env?.AIG_OPS_VARIABLES_JSON, "${{ toJSON(vars) }}");
  assert.deepEqual(variableJob.outputs, {
    variables_b64: "${{ steps.variables.outputs.variables_b64 }}",
  });
  const depends = deploy.needs as string[];
  assert.deepEqual(depends, ["prepare", "gateway_variables"]);
  assert.match(String(deploy.if), /needs\.gateway_variables\.result == 'success'/);
  assert.match(String(deploy.if), /needs\.gateway_variables\.result == 'skipped'/);
  const exportStep = (deploy.steps as Array<{ name: string; env?: Record<string, string> }>).find(
    (step) => step.name === "Export scoped deployment variables"
  );
  assert.equal(
    exportStep?.env?.AW_GATEWAY_VARIABLES_B64_FROM_OPS,
    "${{ needs.gateway_variables.outputs.variables_b64 }}"
  );
});
