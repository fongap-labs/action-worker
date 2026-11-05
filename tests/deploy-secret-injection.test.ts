import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import test from "node:test";
import {
  readDeploySecretBundleName,
  readDeploySecretVariableSources,
  resolveDeploySecretPlan,
} from "../scripts/resolve-secret-scope.ts";
import { buildScopedDeployEnvironment, loadScopedSecretValues } from "../scripts/run-scoped-deploy.ts";
import { stageDeploySecretBundle } from "../scripts/stage-deploy-secret-bundle.ts";

test("deploy secret plan separates stored Secrets from explicitly declared Repository Variables", async () => {
  const root = await mkdtemp(join(tmpdir(), "deploy-secret-plan-"));
  try {
    const required = join(root, "required");
    const allowed = join(root, "allowed");
    const policy = join(root, "policy.json");
    await writeFile(required, "TOKEN_REQUIRED\nACCOUNT_ID\n");
    await writeFile(allowed, "TOKEN_OPTIONAL\n");
    await writeFile(policy, JSON.stringify({
      schema_version: 1,
      deployments: {
        "owner/repo": {
          production: {
            bundle_secret: "AW_DEPLOY_SECRET_BUNDLE_EXAMPLE",
            required: ["TOKEN_REQUIRED"],
            allowed: ["TOKEN_OPTIONAL", "ACCOUNT_ID"],
            aliases: { ACCOUNT_ID: "ACCOUNT_ID_VARIABLE" },
            variable_sources: ["ACCOUNT_ID_VARIABLE"],
          },
        },
      },
    }));
    const variableSources = await readDeploySecretVariableSources(policy, "owner/repo", "production");
    assert.deepEqual([...variableSources], ["ACCOUNT_ID_VARIABLE"]);
    assert.equal(
      await readDeploySecretBundleName(policy, "owner/repo", "production"),
      "AW_DEPLOY_SECRET_BUNDLE_EXAMPLE",
    );
    const plan = await resolveDeploySecretPlan(required, allowed, policy, "owner/repo", "production", "", {
      PATH: "/usr/bin", ACCOUNT_ID_VARIABLE: "account-id",
    });
    assert.deepEqual(plan, [
      { name: "ACCOUNT_ID", source: "ACCOUNT_ID_VARIABLE", required: true, kind: "variable" },
      { name: "TOKEN_OPTIONAL", source: "TOKEN_OPTIONAL", required: false, kind: "secret" },
      { name: "TOKEN_REQUIRED", source: "TOKEN_REQUIRED", required: true, kind: "secret" },
    ]);
    await assert.rejects(
      resolveDeploySecretPlan(required, allowed, policy, "owner/repo", "production", "", { PATH: "/usr/bin" }),
      /Required deploy variable is unavailable: ACCOUNT_ID/,
    );
    await writeFile(allowed, "UNAUTHORIZED_SECRET\n");
    await assert.rejects(
      resolveDeploySecretPlan(required, allowed, policy, "owner/repo", "production", "", {
        PATH: "/usr/bin", ACCOUNT_ID_VARIABLE: "x",
      }),
      /outside the central deploy secret policy: UNAUTHORIZED_SECRET/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("shipped policy assigns a unique product bundle and preserves the AI Gateway variable alias", async () => {
  const aiGateway = await readDeploySecretBundleName(
    "policies/deploy-secrets.json", "fongap-labs/ai-gateway", "production",
  );
  const serverEdge = await readDeploySecretBundleName(
    "policies/deploy-secrets.json", "fongap-labs/internal-vault", "server-edge-cloud-edge", "server-edge",
  );
  const mcpHub = await readDeploySecretBundleName(
    "policies/deploy-secrets.json", "fongap-labs/mcp-hub", "production",
  );
  assert.deepEqual(
    [aiGateway, serverEdge, mcpHub],
    [
      "AW_DEPLOY_SECRET_BUNDLE_AI_GATEWAY",
      "AW_DEPLOY_SECRET_BUNDLE_SERVER_EDGE",
      "AW_DEPLOY_SECRET_BUNDLE_MCP_HUB",
    ],
  );
  const sources = await readDeploySecretVariableSources(
    "policies/deploy-secrets.json", "fongap-labs/ai-gateway", "production",
  );
  assert.deepEqual([...sources], ["CLOUDFLARE_ACCOUNT_ID_SECONDARY"]);
  const hubSources = await readDeploySecretVariableSources(
    "policies/deploy-secrets.json", "fongap-labs/mcp-hub", "production",
  );
  assert.deepEqual([...hubSources], []);
});

test("product bundle stages only plan-authorized Secret values and rejects unknown keys", async () => {
  const root = await mkdtemp(join(tmpdir(), "deploy-secret-bundle-"));
  try {
    const plan = {
      schema_version: 1 as const,
      secrets: [
        { name: "TOKEN_REQUIRED", source: "TOKEN_REQUIRED", required: true, kind: "secret" as const },
        { name: "TOKEN_OPTIONAL", source: "TOKEN_OPTIONAL", required: false, kind: "secret" as const },
        { name: "ACCOUNT_ID", source: "ACCOUNT_ID_VARIABLE", required: true, kind: "variable" as const },
      ],
    };
    const staged = await stageDeploySecretBundle(
      JSON.stringify({ TOKEN_REQUIRED: "test-value" }),
      plan,
      root,
    );
    assert.deepEqual(staged, ["TOKEN_REQUIRED"]);
    assert.equal(
      await readFile(join(root, "action-worker-deploy-secrets", "TOKEN_REQUIRED"), "utf8"),
      "test-value",
    );
    await assert.rejects(
      stageDeploySecretBundle(JSON.stringify({ TOKEN_OPTIONAL: "extra" }), plan, root),
      /Required deploy Secret is missing from the product bundle: TOKEN_REQUIRED/,
    );
    await assert.rejects(
      stageDeploySecretBundle(JSON.stringify({ TOKEN_REQUIRED: "x", OTHER_SECRET: "nope" }), plan, root),
      /outside the current deployment plan: OTHER_SECRET/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the deploy child receives only declared secrets and alias values, never control-plane credentials", () => {
  const plan = {
    schema_version: 1 as const,
    secrets: [
      { name: "CLOUDFLARE_API_TOKEN", source: "CLOUDFLARE_API_TOKEN_SECONDARY", required: true, kind: "secret" as const },
      { name: "CLOUDFLARE_ACCOUNT_ID", source: "CLOUDFLARE_ACCOUNT_ID_SECONDARY", required: true, kind: "variable" as const },
      { name: "OPTIONAL_TOKEN", source: "OPTIONAL_TOKEN", required: false, kind: "secret" as const },
    ],
  };
  const base = {
    PATH: "/usr/bin", DEPLOY_SOURCE_REPOSITORY: "owner/repo",
    CLOUDFLARE_ACCOUNT_ID_SECONDARY: "account-id", AW_CONTROL_TOKEN: "control-token",
    AW_CHECKOUT_TOKEN: "checkout-token", GH_TOKEN: "gh-token", GITHUB_TOKEN: "github-token",
    NODE_OPTIONS: "--require injected.js", GITHUB_OUTPUT: "/tmp/output",
  };
  const environment = buildScopedDeployEnvironment(base, plan, new Map([
    ["CLOUDFLARE_API_TOKEN", "cloudflare-token"],
  ]));
  assert.equal(environment.PATH, "/usr/bin");
  assert.equal(environment.DEPLOY_SOURCE_REPOSITORY, "owner/repo");
  assert.equal(environment.CLOUDFLARE_API_TOKEN, "cloudflare-token");
  assert.equal(environment.CLOUDFLARE_ACCOUNT_ID, "account-id");
  for (const name of [
    "CLOUDFLARE_API_TOKEN_SECONDARY", "CLOUDFLARE_ACCOUNT_ID_SECONDARY", "OPTIONAL_TOKEN",
    "AW_CONTROL_TOKEN", "AW_CHECKOUT_TOKEN", "GH_TOKEN", "GITHUB_TOKEN", "NODE_OPTIONS", "GITHUB_OUTPUT",
  ]) assert.equal(environment[name], undefined, name);
});

test("staged Secret files are restricted to the plan and have private permissions", async () => {
  const root = await mkdtemp(join(tmpdir(), "deploy-secret-load-"));
  try {
    const plan = {
      schema_version: 1 as const,
      secrets: [
        { name: "TOKEN_A", source: "TOKEN_A", required: true, kind: "secret" as const },
        { name: "TOKEN_B", source: "TOKEN_B", required: false, kind: "secret" as const },
      ],
    };
    await stageDeploySecretBundle(JSON.stringify({ TOKEN_A: "a" }), plan, root);
    const values = await loadScopedSecretValues(join(root, "action-worker-deploy-secrets"), plan);
    assert.deepEqual([...values], [["TOKEN_A", "a"]]);
    await writeFile(join(root, "action-worker-deploy-secrets", "OTHER"), "x");
    await assert.rejects(
      loadScopedSecretValues(join(root, "action-worker-deploy-secrets"), plan),
      /Unexpected file/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the deploy workflow dynamically injects one product bundle and stays repository-agnostic", async () => {
  const workflow = parse(await readFile(".github/workflows/deploy-source-script.yml", "utf8")) as {
    jobs: Record<string, { steps?: Array<{ name?: string; env?: Record<string, string>; run?: string }> }>;
  };
  const steps = workflow.jobs.deploy?.steps ?? [];
  const plan = steps.find((step) => step.name === "Resolve deploy Secret plan");
  const stage = steps.find((step) => step.name === "Stage selected product deployment Secret bundle");
  const execute = steps.find((step) => step.name === "Execute source-owned deploy entrypoint");
  assert.match(plan?.run ?? "", /resolve-deploy-secret-plan\.ts/);
  assert.deepEqual(Object.keys(stage?.env ?? {}), ["AW_DEPLOY_SECRET_BUNDLE"]);
  assert.equal(
    stage?.env?.AW_DEPLOY_SECRET_BUNDLE,
    "$" + "{{ secrets[steps.secret_plan.outputs.bundle_secret_name] }}",
  );
  assert.equal(stage?.run, "node control/scripts/stage-deploy-secret-bundle.ts");
  assert.equal(execute?.env, undefined);
  assert.match(execute?.run ?? "", /run-scoped-deploy\.ts/);
  const sourceText = await readFile(".github/workflows/deploy-source-script.yml", "utf8");
  assert.equal(sourceText.includes("env: $" + "{{ secrets }}"), false);
  for (const name of ["AIG_ACCESS_KEY_AGENT", "SERVER_EDGE_SECRET_BUNDLE", "CLOUDFLARE_API_TOKEN_SECONDARY"]) {
    assert.equal(sourceText.includes("secrets." + name), false, name);
  }
});
