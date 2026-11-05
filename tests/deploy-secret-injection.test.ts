import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import test from "node:test";
import { readDeploySecretVariableSources, resolveDeploySecretPlan } from "../scripts/resolve-secret-scope.ts";
import { buildScopedDeployEnvironment, loadScopedSecretValues } from "../scripts/run-scoped-deploy.ts";
import { stageDeploySecretValue } from "../scripts/write-deploy-secret.ts";

test("deploy secret plan separates stored Secrets from explicitly declared Repository Variables", async () => {
  const root = await mkdtemp(join(tmpdir(), "deploy-secret-plan-"));
  try {
    const required = join(root, "required");
    const allowed = join(root, "allowed");
    const policy = join(root, "policy.json");
    await writeFile(required, "TOKEN_REQUIRED\n");
    await writeFile(allowed, "TOKEN_OPTIONAL\nACCOUNT_ID\n");
    await writeFile(policy, JSON.stringify({
      schema_version: 1,
      deployments: {
        "owner/repo": {
          production: {
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
      resolveDeploySecretPlan(required, allowed, policy, "owner/repo", "production", "", { PATH: "/usr/bin", ACCOUNT_ID_VARIABLE: "x" }),
      /outside the central deploy secret policy: UNAUTHORIZED_SECRET/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("shipped policy marks only the AI Gateway account ID alias as a Repository Variable", async () => {
  const sources = await readDeploySecretVariableSources(
    "policies/deploy-secrets.json", "fongap-labs/ai-gateway", "production"
  );
  assert.deepEqual([...sources], ["CLOUDFLARE_ACCOUNT_ID_SECONDARY"]);
  const hubSources = await readDeploySecretVariableSources(
    "policies/deploy-secrets.json", "fongap-labs/mcp-hub", "production"
  );
  assert.deepEqual([...hubSources], []);
});

test("only the requested stored Secret is staged and missing optional values are omitted", async () => {
  const root = await mkdtemp(join(tmpdir(), "deploy-secret-stage-"));
  try {
    const plan = {
      schema_version: 1 as const,
      secrets: [
        { name: "TOKEN_REQUIRED", source: "TOKEN_REQUIRED", required: true, kind: "secret" as const },
        { name: "TOKEN_OPTIONAL", source: "TOKEN_OPTIONAL", required: false, kind: "secret" as const },
      ],
    };
    assert.equal(await stageDeploySecretValue("TOKEN_REQUIRED", "test-value", plan, root), true);
    assert.equal(await stageDeploySecretValue("TOKEN_OPTIONAL", "", plan, root), false);
    assert.equal(await readFile(join(root, "action-worker-deploy-secrets", "TOKEN_REQUIRED"), "utf8"), "test-value");
    await assert.rejects(stageDeploySecretValue("TOKEN_REQUIRED", "", plan, root), /Required deploy Secret is unavailable/);
    await assert.rejects(stageDeploySecretValue("UNDECLARED", "nope", plan, root), /not in the approved plan/);
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
    await stageDeploySecretValue("TOKEN_A", "a", plan, root);
    const values = await loadScopedSecretValues(join(root, "action-worker-deploy-secrets"), plan);
    assert.deepEqual([...values], [["TOKEN_A", "a"]]);
    await writeFile(join(root, "action-worker-deploy-secrets", "OTHER"), "x");
    await assert.rejects(loadScopedSecretValues(join(root, "action-worker-deploy-secrets"), plan), /Unexpected file/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the deploy workflow has one-secret collector steps and no broad Secrets context", async () => {
  const workflow = parse(await readFile(".github/workflows/deploy-source-script.yml", "utf8")) as {
    jobs: Record<string, { steps?: Array<{ name?: string; if?: string; env?: Record<string, string>; run?: string }> }>;
  };
  const steps = workflow.jobs.deploy?.steps ?? [];
  const collectors = steps.filter((step) => step.name?.startsWith("Collect scoped deploy Secret "));
  const policy = JSON.parse(await readFile("policies/deploy-secrets.json", "utf8")) as {
    deployments: Record<string, Record<string, { required?: string[]; allowed?: string[]; aliases?: Record<string, string>; variable_sources?: string[] }>>;
  };
  const expected = new Set<string>();
  for (const environments of Object.values(policy.deployments)) {
    for (const entry of Object.values(environments)) {
      for (const name of [...(entry.required ?? []), ...(entry.allowed ?? [])]) {
        const source = entry.aliases?.[name] ?? name;
        if (!(entry.variable_sources ?? []).includes(source)) expected.add(source);
      }
    }
  }
  const actual = new Set<string>();
  for (const step of collectors) {
    const source = step.name?.replace("Collect scoped deploy Secret ", "") ?? "";
    actual.add(source);
    assert.deepEqual(Object.keys(step.env ?? {}), ["AW_DEPLOY_SECRET_VALUE"]);
    assert.equal(step.env?.AW_DEPLOY_SECRET_VALUE, "${{ secrets." + source + " }}");
    assert.match(step.if ?? "", /steps\.secret_plan\.outputs\.inject_sources/);
    assert.equal(step.run, "node control/scripts/write-deploy-secret.ts " + source);
  }
  assert.deepEqual([...actual].sort(), [...expected].sort());
  const sourceText = await readFile(".github/workflows/deploy-source-script.yml", "utf8");
  assert.doesNotMatch(sourceText, /env:\s*\$\{\{\s*secrets\s*\}\}/);
  const execute = steps.find((step) => step.name === "Execute source-owned deploy entrypoint");
  assert.equal(execute?.env, undefined);
  assert.match(execute?.run ?? "", /run-scoped-deploy\.ts/);
  assert.equal(expected.has("CLOUDFLARE_ACCOUNT_ID_SECONDARY"), false);
  assert.equal(expected.has("MCP_RUNTIME_KEY"), false);
});
