import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  readDeploySecretCeiling,
  readSecretAliases,
  readTaskSecretCeiling,
  resolveSecretPolicyMode,
  resolveSecretScope,
} from "../scripts/resolve-secret-scope.ts";

test("secret scope exposes only source-declared secrets", async () => {
  const root = await mkdtemp(join(tmpdir(), "secret-scope-"));
  const baseline = join(root, "baseline");
  const required = join(root, "required");
  const allowed = join(root, "allowed");
  await writeFile(baseline, "PATH\nPROJECT\n");
  await writeFile(required, "APP_REQUIRED\n");
  await writeFile(allowed, "APP_OPTIONAL\n");

  const scope = await resolveSecretScope(baseline, required, allowed, [], {
    PATH: "/bin",
    PROJECT: "example",
    APP_REQUIRED: "required",
    APP_OPTIONAL: "optional",
    OTHER_SECRET: "hidden",
    AW_CONTROL_TOKEN: "hidden",
  });
  assert.deepEqual(scope.allowed, ["APP_OPTIONAL", "APP_REQUIRED"]);
  assert.deepEqual(scope.required, ["APP_REQUIRED"]);
  assert.deepEqual(scope.unset, ["AW_CONTROL_TOKEN", "OTHER_SECRET"]);
});

test("base control-plane secrets can never be requested", async () => {
  const root = await mkdtemp(join(tmpdir(), "secret-scope-"));
  const baseline = join(root, "baseline");
  const required = join(root, "required");
  await writeFile(baseline, "PATH\n");
  await writeFile(required, "AW_CONTROL_TOKEN\n");
  await assert.rejects(
    resolveSecretScope(baseline, required, "", [], { PATH: "/bin", AW_CONTROL_TOKEN: "x" }),
    /invalid or reserved/
  );
});

test("capability-specific denied secrets remain unavailable to tasks", async () => {
  const root = await mkdtemp(join(tmpdir(), "secret-scope-"));
  const baseline = join(root, "baseline");
  const allowed = join(root, "allowed");
  await writeFile(baseline, "PATH\n");
  await writeFile(allowed, "AIG_ACCESS_KEY_AGENT\n");
  await assert.rejects(
    resolveSecretScope(baseline, "", allowed, ["AIG_ACCESS_KEY_AGENT"], {
      PATH: "/bin",
      AIG_ACCESS_KEY_AGENT: "agent-key",
    }),
    /denied for this capability/
  );
});

test("privileged deploy may expose an explicitly declared application secret", async () => {
  const root = await mkdtemp(join(tmpdir(), "secret-scope-"));
  const baseline = join(root, "baseline");
  const allowed = join(root, "allowed");
  await writeFile(baseline, "PATH\n");
  await writeFile(allowed, "AIG_ACCESS_KEY_AGENT\n");
  const scope = await resolveSecretScope(baseline, "", allowed, [], {
    PATH: "/bin",
    AIG_ACCESS_KEY_AGENT: "agent-key",
    AW_CONTROL_TOKEN: "control",
    OTHER_SECRET: "hidden",
  });
  assert.deepEqual(scope.allowed, ["AIG_ACCESS_KEY_AGENT"]);
  assert.deepEqual(scope.unset, ["AW_CONTROL_TOKEN", "OTHER_SECRET"]);
});

async function scopeFiles(requiredNames: string, allowedNames: string) {
  const root = await mkdtemp(join(tmpdir(), "secret-scope-"));
  const files = {
    baseline: join(root, "baseline"),
    required: join(root, "required"),
    allowed: join(root, "allowed"),
  };
  await writeFile(files.baseline, "PATH\n");
  await writeFile(files.required, requiredNames);
  await writeFile(files.allowed, allowedNames);
  return { root, ...files };
}

test("central task secret ceiling only reports in warn mode", async () => {
  const { baseline, required, allowed } = await scopeFiles("APP_REQUIRED\n", "APP_EXTRA\n");
  const environment = { PATH: "/bin", APP_REQUIRED: "x", APP_EXTRA: "y" };

  const within = await resolveSecretScope(baseline, required, allowed, [], environment, {
    names: new Set(["APP_REQUIRED", "APP_EXTRA", "APP_UNUSED"]),
    mode: "warn",
  });
  assert.deepEqual(within.policy_excess, []);

  const warned = await resolveSecretScope(baseline, required, allowed, [], environment, {
    names: new Set(["APP_REQUIRED"]),
    mode: "warn",
  });
  assert.deepEqual(warned.policy_excess, ["APP_EXTRA"]);
  assert.deepEqual(warned.allowed, ["APP_EXTRA", "APP_REQUIRED"]);
  assert.deepEqual(warned.unset, []);

  const unchecked = await resolveSecretScope(baseline, required, allowed, [], environment);
  assert.deepEqual(unchecked.policy_excess, []);
});

test("central task secret ceiling rejects undeclared names in enforce mode", async () => {
  const { baseline, required, allowed } = await scopeFiles("APP_REQUIRED\n", "APP_EXTRA\n");
  await assert.rejects(
    resolveSecretScope(
      baseline,
      required,
      allowed,
      [],
      { PATH: "/bin", APP_REQUIRED: "x" },
      {
        names: new Set(["APP_REQUIRED"]),
        mode: "enforce",
      }
    ),
    /outside the central task secret policy: APP_EXTRA/
  );
  await assert.rejects(
    resolveSecretScope(
      baseline,
      required,
      allowed,
      [],
      { PATH: "/bin", APP_REQUIRED: "x" },
      {
        names: new Set(),
        mode: "enforce",
      }
    ),
    /APP_EXTRA, APP_REQUIRED/
  );
});

test("task secret policy is read per repository and project and fails closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "secret-policy-"));
  const policyPath = join(root, "task-secrets.json");
  await writeFile(
    policyPath,
    JSON.stringify({
      schema_version: 1,
      tasks: { "owner/repo": { Alpha: { required: ["A_ONE"], allowed: ["A_TWO"] }, Beta: {} } },
    })
  );
  assert.deepEqual([...(await readTaskSecretCeiling(policyPath, "owner/repo", "Alpha"))].sort(), [
    "A_ONE",
    "A_TWO",
  ]);
  assert.equal((await readTaskSecretCeiling(policyPath, "owner/repo", "Beta")).size, 0);
  assert.equal((await readTaskSecretCeiling(policyPath, "owner/repo", "Gamma")).size, 0);
  assert.equal((await readTaskSecretCeiling(policyPath, "owner/other", "Alpha")).size, 0);

  for (const bad of [
    { schema_version: 2, tasks: {} },
    { schema_version: 1 },
    { schema_version: 1, tasks: { "owner/repo": { Alpha: { required: ["AW_CONTROL_TOKEN"] } } } },
    { schema_version: 1, tasks: { "owner/repo": { Alpha: { allowed: "A_ONE" } } } },
    { schema_version: 1, tasks: { "owner/repo": { Alpha: { allowed: ["lower_case"] } } } },
  ]) {
    await writeFile(policyPath, JSON.stringify(bad));
    await assert.rejects(
      readTaskSecretCeiling(policyPath, "owner/repo", "Alpha"),
      /Task secret policy/
    );
  }
});

test("shipped task secret policy is valid and denies unknown tasks", async () => {
  const policyPath = "policies/task-secrets.json";
  const blog = await readTaskSecretCeiling(policyPath, "fongap-labs/internal-vault", "FongapBlog");
  assert.equal(blog.has("CLOUDFLARE_API_TOKEN"), true);
  assert.equal(blog.has("AIG_ACCESS_KEY_AGENT"), false);
  assert.equal((await readTaskSecretCeiling(policyPath, "fongap-labs/unknown", "Any")).size, 0);
  assert.equal(
    (await readTaskSecretCeiling(policyPath, "fongap-labs/ai-gateway", "model-discovery")).size,
    30
  );
});

test("the secret policy mode is closed unless a repository variable opens it", () => {
  assert.equal(resolveSecretPolicyMode("task", undefined), "enforce");
  assert.equal(resolveSecretPolicyMode("deploy", undefined), "enforce");
  assert.equal(resolveSecretPolicyMode("task", "warn"), "warn");
  assert.equal(resolveSecretPolicyMode("deploy", "enforce"), "enforce");
  assert.throws(() => resolveSecretPolicyMode("task", "maybe"), /must be warn or enforce/);
  assert.throws(() => resolveSecretPolicyMode("deploy", ""), /must be warn or enforce/);
});

test("a task the central policy does not list is refused with the entry it needs", async () => {
  const root = await mkdtemp(join(tmpdir(), "secret-scope-"));
  const policyPath = join(root, "policy.json");
  await writeFile(policyPath, JSON.stringify({ schema_version: 1, tasks: {} }));
  await assert.rejects(
    readTaskSecretCeiling(policyPath, "fongap-labs/example", "Example", ["APP_TOKEN"]),
    (error: Error) =>
      error.message.includes("has no entry for fongap-labs/example Example") &&
      error.message.includes("APP_TOKEN")
  );
  assert.equal((await readTaskSecretCeiling(policyPath, "fongap-labs/example", "Example")).size, 0);
});

const cloudflareAliases = new Map([["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_API_TOKEN_SECONDARY"]]);
const cloudflareCeiling = {
  names: new Set(["CLOUDFLARE_API_TOKEN"]),
  mode: "enforce" as const,
  aliases: cloudflareAliases,
};

test("an aliased name takes its value from the stored secret the policy names", async () => {
  const files = await scopeFiles("CLOUDFLARE_API_TOKEN\n", "");
  const scope = await resolveSecretScope(
    files.baseline,
    files.required,
    files.allowed,
    [],
    {
      PATH: "/bin",
      CLOUDFLARE_API_TOKEN: "token-of-the-other-account",
      CLOUDFLARE_API_TOKEN_PRIMARY: "primary",
      CLOUDFLARE_API_TOKEN_SECONDARY: "secondary",
    },
    cloudflareCeiling
  );
  assert.deepEqual(scope.alias, [
    { name: "CLOUDFLARE_API_TOKEN", from: "CLOUDFLARE_API_TOKEN_SECONDARY" },
  ]);
  // The qualified secrets never reach the task; the declared name is overwritten by the alias.
  assert.deepEqual(scope.unset, ["CLOUDFLARE_API_TOKEN_PRIMARY", "CLOUDFLARE_API_TOKEN_SECONDARY"]);
});

test("a required aliased name does not fall back to the stored secret of its own name", async () => {
  const files = await scopeFiles("CLOUDFLARE_API_TOKEN\n", "");
  await assert.rejects(
    resolveSecretScope(
      files.baseline,
      files.required,
      files.allowed,
      [],
      { PATH: "/bin", CLOUDFLARE_API_TOKEN: "token-of-the-other-account" },
      cloudflareCeiling
    ),
    /Required task secret is unavailable: CLOUDFLARE_API_TOKEN \(stored as CLOUDFLARE_API_TOKEN_SECONDARY\)/
  );
});

test("an optional aliased name without its stored secret is removed, not left stale", async () => {
  const files = await scopeFiles("", "CLOUDFLARE_API_TOKEN\n");
  const scope = await resolveSecretScope(
    files.baseline,
    files.required,
    files.allowed,
    [],
    { PATH: "/bin", CLOUDFLARE_API_TOKEN: "token-of-the-other-account" },
    cloudflareCeiling
  );
  assert.deepEqual(scope.alias, []);
  assert.deepEqual(scope.unset, ["CLOUDFLARE_API_TOKEN"]);
});

test("a policy cannot alias to a reserved, declared or repeated name", async () => {
  const root = await mkdtemp(join(tmpdir(), "secret-alias-policy-"));
  const policyPath = join(root, "policy.json");
  const write = (aliases: Record<string, unknown>) =>
    writeFile(
      policyPath,
      JSON.stringify({
        schema_version: 1,
        tasks: {
          "o/r": {
            p: { required: ["A_TOKEN", "B_TOKEN"], allowed: [], aliases },
          },
        },
      })
    );
  await write({ A_TOKEN: "A_TOKEN_PRIMARY" });
  assert.deepEqual(
    [...(await readSecretAliases(policyPath, "task", "o/r", "p"))],
    [["A_TOKEN", "A_TOKEN_PRIMARY"]]
  );
  for (const aliases of [
    { A_TOKEN: "AW_CONTROL_TOKEN" },
    { A_TOKEN: "B_TOKEN" },
    { A_TOKEN: "A_TOKEN" },
    { A_TOKEN: "SHARED", B_TOKEN: "SHARED" },
    { UNDECLARED: "SOMETHING_ELSE" },
  ]) {
    await write(aliases);
    await assert.rejects(readSecretAliases(policyPath, "task", "o/r", "p"), /alias is invalid/);
  }
});

test("AI Gateway production deploy ceiling contains only Cloudflare, center auth and Provider shards", async () => {
  const policyPath = "policies/deploy-secrets.json";
  const gateway = await readDeploySecretCeiling(policyPath, "fongap-labs/ai-gateway", "production");
  const hub = await readDeploySecretCeiling(policyPath, "fongap-labs/mcp-hub", "production");
  assert.deepEqual([...gateway].sort(), [
    "AIG_GENERATION_AUTH_KEY",
    "AIG_INFERENCE_AUTH_KEY",
    "AIG_PERCEPTION_AUTH_KEY",
    ...[1, 2].flatMap((tier) =>
      Array.from(
        { length: 10 },
        (_, index) => `AIG_TIER${tier}_CREDENTIALS_${String(index + 1).padStart(2, "0")}`
      )
    ),
    "CLOUDFLARE_ACCOUNT_ID",
    "CLOUDFLARE_API_TOKEN",
  ]);
  for (const name of [
    "AIG_TOKEN_ENCRYPTION_KEY",
    "AIG_ACCESS_KEY_AIR",
    "AIG_ACCESS_KEY_PRO",
    "AIG_ACCESS_KEY_MAX",
    "AIG_ACCESS_KEY_ULTRA",
    "AIG_ACCESS_KEY_AGENT",
    "AIG_TIER1_CREDENTIALS_11",
  ]) {
    assert.equal(gateway.has(name), false, `${name} is not a production deployment secret`);
  }
  assert.equal(hub.has("AIG_INFERENCE_AUTH_KEY"), false);
  assert.equal(gateway.has("AW_APP_PRIVATE_KEY"), false);
});

test("the central policies give each Cloudflare account its own qualified secret", async () => {
  const deploy = await readSecretAliases(
    "policies/deploy-secrets.json",
    "deploy",
    "fongap-labs/ai-gateway",
    "production"
  );
  assert.deepEqual(
    [...deploy],
    [
      ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_API_TOKEN_REPOSITORY"],
      ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_ACCOUNT_ID_SECONDARY"],
      ["AIG_INFERENCE_AUTH_KEY", "AIG_INFERENCE_AUTH_KEY_REPOSITORY"],
      ["AIG_PERCEPTION_AUTH_KEY", "AIG_PERCEPTION_AUTH_KEY_REPOSITORY"],
      ["AIG_GENERATION_AUTH_KEY", "AIG_GENERATION_AUTH_KEY_REPOSITORY"],
    ]
  );
  const gateway = await readDeploySecretCeiling(
    "policies/deploy-secrets.json",
    "fongap-labs/ai-gateway",
    "production"
  );
  assert.equal(gateway.has("AIG_ACCESS_KEY_AGENT"), false);
  assert.equal(gateway.has("AIG_DEPLOY_HEALTH_KEY"), false);
  assert.equal(
    deploy.has("AIG_DEPLOY_HEALTH_KEY"),
    false,
    "The removed health credential is absent from deployment aliases"
  );
  // The retired inference product has no deployment credential aliases.
  const retired = await readSecretAliases(
    "policies/deploy-secrets.json",
    "deploy",
    "fongap-labs/ai-gateway/inference-center",
    "inference-center-ops"
  );
  assert.deepEqual([...retired], []);
  for (const project of ["FongapBlog"]) {
    const task = await readSecretAliases(
      "policies/task-secrets.json",
      "task",
      "fongap-labs/internal-vault",
      project
    );
    assert.deepEqual(
      [...task],
      [
        ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_API_TOKEN_PRIMARY"],
        ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_ACCOUNT_ID_PRIMARY"],
      ]
    );
  }
  const retiredCdnTask = await readSecretAliases(
    "policies/task-secrets.json",
    "task",
    "fongap-labs/internal-vault",
    "FongapCDN"
  );
  assert.deepEqual([...retiredCdnTask], []);
  const cdnDeploy = await readSecretAliases(
    "policies/deploy-secrets.json",
    "deploy",
    "fongap-labs/internal-vault/FongapCDN",
    "production"
  );
  assert.deepEqual(
    [...cdnDeploy],
    [
      ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_ACCOUNT_ID_PRIMARY"],
      ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_API_TOKEN_PRIMARY"],
    ]
  );
  // MarketChina uses a dedicated R2 S3 access key; an API token is not interchangeable.
  assert.deepEqual(
    [
      ...(await readSecretAliases(
        "policies/task-secrets.json",
        "task",
        "fongap-labs/internal-vault",
        "MarketChina"
      )),
    ],
    [
      ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_ACCOUNT_ID_PRIMARY"],
      ["CLOUDFLARE_SECRET_KEY", "CLOUDFLARE_SECRET_KEY_PRIMARY"],
      ["CLOUDFLARE_BUCKET_NAME", "CLOUDFLARE_BUCKET_NAME_PRIMARY"],
      ["TUSHARE_API_URL", "TUSHARE_API_URL_PRIMARY"],
      ["TUSHARE_API_TOKEN", "TUSHARE_API_TOKEN_PRIMARY"],
    ]
  );
  // No other project of the same repository is redirected.
  assert.equal(
    (
      await readSecretAliases(
        "policies/task-secrets.json",
        "task",
        "fongap-labs/internal-vault",
        "MarketBrief"
      )
    ).size,
    0
  );
});

test("task execution uses only policy-scoped Secret slots; deployment remains scoped", async () => {
  const taskWorkflow = await readFile(".github/workflows/handle-task-dispatch.yml", "utf8");
  assert.match(taskWorkflow, /resolve-task-secret-plan\.ts resolve/);
  assert.match(taskWorkflow, /resolve-task-secret-plan\.ts verify/);
  assert.match(taskWorkflow, /secrets\[steps\.task_secret_plan\.outputs\.secret_00\]/);
  assert.match(taskWorkflow, /AW_TASK_SECRET_SLOT_32:/);
  assert.match(taskWorkflow, /unset "\$slot" value/);
  assert.match(taskWorkflow, /Central credential survived task isolation/);
  assert.doesNotMatch(taskWorkflow, /env:\s*\$\{\{\s*secrets\s*\}\}/);

  const deployWorkflow = await readFile(".github/workflows/deploy-source-script.yml", "utf8");
  assert.match(deployWorkflow, /resolve-deploy-secret-plan\.ts/);
  assert.match(deployWorkflow, /secrets\[steps\.secret_plan\.outputs\.secret_00\]/);
  assert.match(deployWorkflow, /stage-deploy-secret-bundle\.ts/);
  assert.doesNotMatch(deployWorkflow, /env:\s*\$\{\{\s*secrets\s*\}\}/);
  assert.doesNotMatch(deployWorkflow, /secrets\.CLOUDFLARE_API_TOKEN_SECONDARY/);
});

test("AI Gateway operations workflow is protected and never accepts secret values as inputs", async () => {
  const workflow = await readFile(".github/workflows/ai-gateway-ops.yml", "utf8");
  const handler = await readFile("scripts/ai-gateway-ops.ts", "utf8");
  assert.match(workflow, /environment:\s*\n\s*name: ai-gateway-ops\s*\n\s*deployment: false/);
  assert.match(workflow, /if: github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /repository_dispatch:/);
  assert.match(workflow, /CLOUDFLARE_API_TOKEN_OPS/);
  assert.match(workflow, /AIG_OPS_SECRET_VALUE/);
  assert.doesNotMatch(workflow, /AIG_DEPLOY_HEALTH_KEY/);
  assert.match(workflow, /node scripts\/ai-gateway-ops\.ts put/);
  assert.match(workflow, /node scripts\/ai-gateway-ops\.ts inventory/);
  assert.match(workflow, /persist-credentials: false/);
  assert.doesNotMatch(workflow, /wrangler|ops-placeholder|deploy\s+--config|rollback/);
  assert.doesNotMatch(workflow, /echo[^\n]*\$AIG_OPS_SECRET_VALUE/);
  assert.doesNotMatch(workflow, /secret_value:\s*\n\s*required:/i);
  assert.match(handler, /PUT/);
  assert.match(handler, /workers\/scripts\//);
  assert.match(handler, /Content-Type/);
  assert.doesNotMatch(handler, /spawn|exec|child_process|wrangler/);
});

test("task and deploy Secret aliases preserve credential types", async () => {
  const policy = JSON.parse(await readFile("policies/task-secrets.json", "utf8")) as {
    tasks: Record<string, Record<string, { aliases?: Record<string, string> }>>;
  };
  const credentialType = (name: string): string | undefined => {
    const normalized = name.replace(/_(?:PRIMARY|SECONDARY|[0-9]+)$/, "");
    const types: Array<[RegExp, string]> = [
      [/(?:^|_)ACCESS_KEY$/, "access-key"],
      [/(?:^|_)API_TOKEN$/, "api-token"],
      [/(?:^|_)SECRET_KEY$/, "secret-key"],
      [/(?:^|_)PRIVATE_KEY$/, "private-key"],
      [/(?:^|_)ACCOUNT_ID$/, "account-id"],
      [/(?:^|_)BUCKET_NAME$/, "bucket-name"],
      [/(?:^|_)PASSWORD$/, "password"],
    ];
    return types.find(([pattern]) => pattern.test(normalized))?.[1];
  };
  const mismatches: string[] = [];
  for (const [repository, projects] of Object.entries(policy.tasks)) {
    for (const [project, entry] of Object.entries(projects)) {
      for (const [logical, stored] of Object.entries(entry.aliases ?? {})) {
        const logicalType = credentialType(logical);
        const storedType = credentialType(stored);
        if (logicalType && storedType && logicalType !== storedType) {
          mismatches.push(`${repository}:${project}:${logicalType}->${storedType}`);
        }
      }
    }
  }
  const deployPolicy = JSON.parse(await readFile("policies/deploy-secrets.json", "utf8")) as {
    deployments: Record<string, Record<string, { aliases?: Record<string, string> }>>;
  };
  for (const [deployment, environments] of Object.entries(deployPolicy.deployments)) {
    for (const [environment, entry] of Object.entries(environments)) {
      for (const [logical, stored] of Object.entries(entry.aliases ?? {})) {
        const logicalType = credentialType(logical);
        const storedType = credentialType(stored);
        if (logicalType && storedType && logicalType !== storedType) {
          mismatches.push(`${deployment}:${environment}:${logicalType}->${storedType}`);
        }
      }
    }
  }
  assert.deepEqual(mismatches, []);
});

test("deploy variable sources cannot be credential-bearing names", async () => {
  const policy = JSON.parse(await readFile("policies/deploy-secrets.json", "utf8")) as {
    deployments: Record<
      string,
      Record<string, { aliases?: Record<string, string>; variable_sources?: string[] }>
    >;
  };
  const violations: string[] = [];
  const sensitiveName =
    /(?:^|_)(?:TOKEN|SECRET|PASSWORD|CREDENTIALS?)(?:_|$)|(?:^|_)(?:PRIVATE|ACCESS|SIGNING|AUTH|API|WRITE|HEALTH)_KEY(?:_|$)/;
  for (const [deployment, environments] of Object.entries(policy.deployments)) {
    for (const [environment, entry] of Object.entries(environments)) {
      const aliasSources = new Set(Object.values(entry.aliases ?? {}));
      for (const source of entry.variable_sources ?? []) {
        if (!aliasSources.has(source) || sensitiveName.test(source)) {
          violations.push(`${deployment}:${environment}`);
        }
      }
    }
  }
  assert.deepEqual(violations, []);
});
