import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";
import {
  assertDeployEnvironmentAllowed,
  parseDeployEnvironmentPolicy,
  resolveDeployManifest,
} from "../scripts/deploy-manifest.ts";
import { isDeployPolicyKey, productPolicyKey } from "../scripts/deploy-policy-key.ts";
import {
  readDeploySecretCeiling,
  readSecretAliases,
  resolveSecretScope,
} from "../scripts/resolve-secret-scope.ts";

const sha = "0123456789abcdef0123456789abcdef01234567";

function encoded(value: unknown): unknown {
  return {
    encoding: "base64",
    content: Buffer.from(JSON.stringify(value), "utf8").toString("base64"),
  };
}

const runnerPolicy = {
  schema_version: 1,
  profiles: {
    "production-deploy": {
      enabled: true,
      backend: "github-hosted",
      trust_domain: "privileged",
      labels: ["ubuntu-24.04"],
      fallback_profiles: [],
    },
  },
};

function readerFor(environment: string) {
  const manifest = {
    schema_version: "1",
    adapter: "source-script",
    automatic: false,
    ignore_docs_only: true,
    runner_profile: "production-deploy",
    environment,
    entrypoint: "scripts/deploy.sh",
  };
  return {
    async get(path: string): Promise<unknown> {
      if (path.includes(".github/deploy.json")) return encoded(manifest);
      if (path.includes("scripts/deploy.sh")) return { type: "file" };
      throw new Error(`unexpected path: ${path}`);
    },
  };
}

const environmentPolicy = {
  schema_version: 1,
  repositories: { "fongap-labs/example": ["production"] },
};
const repositoryPolicy = { "fongap-labs/example": ["deploy"], "fongap-labs/other": ["deploy"] };

test("a manifest that names an environment the central policy does not grant is refused", async () => {
  const resolved = await resolveDeployManifest(
    "fongap-labs/example",
    sha,
    repositoryPolicy,
    runnerPolicy,
    readerFor("production"),
    environmentPolicy
  );
  assert.equal(resolved.environment, "production");

  await assert.rejects(
    resolveDeployManifest(
      "fongap-labs/example",
      sha,
      repositoryPolicy,
      runnerPolicy,
      readerFor("admin-ops"),
      environmentPolicy
    ),
    /not allowed for fongap-labs\/example: admin-ops/
  );
});

test("a repository missing from the policy cannot deploy to any environment", async () => {
  await assert.rejects(
    resolveDeployManifest(
      "fongap-labs/other",
      sha,
      repositoryPolicy,
      runnerPolicy,
      readerFor("production"),
      environmentPolicy
    ),
    /not allowed for fongap-labs\/other: production. Allowed: none/
  );
});

test("one repository cannot use the environment granted to another", () => {
  const policy = parseDeployEnvironmentPolicy({
    schema_version: 1,
    repositories: { "o/a": ["production"], "o/b": ["staging"] },
  });
  assertDeployEnvironmentAllowed(policy, "o/a", "production");
  assert.throws(() => assertDeployEnvironmentAllowed(policy, "o/b", "production"));
  assert.throws(() => assertDeployEnvironmentAllowed(policy, "o/a", "staging"));
  assert.throws(() => assertDeployEnvironmentAllowed(policy, "o/__proto__", "production"));
});

test("an invalid environment policy is rejected", () => {
  for (const value of [
    null,
    { schema_version: 2, repositories: {} },
    { schema_version: 1 },
    { schema_version: 1, repositories: { "not a repo": ["production"] } },
    { schema_version: 1, repositories: { "o/a": "production" } },
    { schema_version: 1, repositories: { "o/a": ["Production"] } },
  ]) {
    assert.throws(() => parseDeployEnvironmentPolicy(value));
  }
});

test("the shipped environment policy parses and keys each deploying product by its product key", async () => {
  const policy = parseDeployEnvironmentPolicy(
    JSON.parse(await readFile("policies/deploy-environments.json", "utf8"))
  );
  assert.deepEqual(policy["fongap-labs/ai-gateway"], ["production"]);
  assert.deepEqual(policy["fongap-labs/internal-vault/server-edge"], ["server-edge-cloud-edge"]);
  // The repository key is gone: the product has no fallback to it.
  assert.equal(Object.hasOwn(policy, "fongap-labs/internal-vault"), false);
});

// --- central deploy secret ceiling ---------------------------------------------------------------

async function withPolicy<T>(policy: unknown, run: (path: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "deploy-secrets-"));
  try {
    const path = join(directory, "deploy-secrets.json");
    await writeFile(path, JSON.stringify(policy), "utf8");
    return await run(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const ceilingPolicy = {
  schema_version: 1,
  deployments: {
    "o/a": { production: { required: ["TOKEN_A"], allowed: ["TOKEN_B"] } },
  },
};

test("the deploy secret ceiling is per repository and environment, and unknown pairs get none", async () => {
  await withPolicy(ceilingPolicy, async (path) => {
    assert.deepEqual([...(await readDeploySecretCeiling(path, "o/a", "production"))].sort(), [
      "TOKEN_A",
      "TOKEN_B",
    ]);
    assert.equal((await readDeploySecretCeiling(path, "o/a", "staging")).size, 0);
    assert.equal((await readDeploySecretCeiling(path, "o/b", "production")).size, 0);
    assert.equal((await readDeploySecretCeiling(path, "o/__proto__", "production")).size, 0);
  });
});

test("reserved names and invalid files are refused in the deploy secret policy", async () => {
  await withPolicy(
    { schema_version: 1, deployments: { "o/a": { production: { allowed: ["AW_ADMIN_TOKEN"] } } } },
    async (path) => {
      await assert.rejects(readDeploySecretCeiling(path, "o/a", "production"));
    }
  );
  await withPolicy({ schema_version: 1, tasks: {} }, async (path) => {
    await assert.rejects(readDeploySecretCeiling(path, "o/a", "production"), /invalid/);
  });
});

test("a target that declares more than the central list is reported, and refused when enforced", async () => {
  const directory = await mkdtemp(join(tmpdir(), "deploy-scope-"));
  try {
    const baseline = join(directory, "base.names");
    const required = join(directory, "required");
    const allowed = join(directory, "allowed");
    await writeFile(baseline, "PATH\n", "utf8");
    await writeFile(required, "", "utf8");
    await writeFile(allowed, "TOKEN_A\nEXTRA_TOKEN\n", "utf8");
    const environment = { PATH: "x", TOKEN_A: "a", EXTRA_TOKEN: "e" };
    const names = new Set(["TOKEN_A"]);

    const warned = await resolveSecretScope(baseline, required, allowed, [], environment, {
      names,
      mode: "warn",
      label: "deploy",
    });
    assert.deepEqual(warned.policy_excess, ["EXTRA_TOKEN"]);

    await assert.rejects(
      resolveSecretScope(baseline, required, allowed, [], environment, {
        names,
        mode: "enforce",
        label: "deploy",
      }),
      /central deploy secret policy: EXTRA_TOKEN/
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the shipped deploy secret policy only holds valid, non-reserved names", async () => {
  const policy = JSON.parse(await readFile("policies/deploy-secrets.json", "utf8"));
  assert.equal(policy.schema_version, 1);
  const aiGateway = await readDeploySecretCeiling(
    "policies/deploy-secrets.json",
    "fongap-labs/ai-gateway",
    "production"
  );
  assert.ok(aiGateway.has("CLOUDFLARE_API_TOKEN"));
  assert.ok(
    aiGateway.has("CLOUDFLARE_ACCOUNT_ID"),
    "the account ID is a Repository Variable injected through a deploy alias"
  );
  assert.equal(aiGateway.size, 38);
  const aiGatewayAliases = await readSecretAliases(
    "policies/deploy-secrets.json",
    "deploy",
    "fongap-labs/ai-gateway",
    "production"
  );
  assert.equal(aiGatewayAliases.get("CLOUDFLARE_API_TOKEN"), "CLOUDFLARE_API_TOKEN_SECONDARY");
  assert.equal(aiGatewayAliases.get("CLOUDFLARE_ACCOUNT_ID"), "CLOUDFLARE_ACCOUNT_ID_SECONDARY");
  const internalVault = await readDeploySecretCeiling(
    "policies/deploy-secrets.json",
    "fongap-labs/internal-vault",
    "server-edge-cloud-edge",
    "server-edge"
  );
  assert.deepEqual([...internalVault].sort(), [
    "SERVER_EDGE_RELEASE_SIGNING_KEY",
    "SERVER_EDGE_SECRET_BUNDLE",
    "SERVER_EDGE_SSH_PRIVATE_KEY",
    "SERVER_EDGE_TAILSCALE_AUTH_KEY",
  ]);
});

// --- workflow invariants -------------------------------------------------------------------------

type Step = { name?: string; env?: unknown; with?: Record<string, unknown>; run?: string };
type Job = { environment?: unknown; steps?: Step[] };
type Workflow = { jobs: Record<string, Job> };

async function workflow(name: string): Promise<Workflow> {
  return parse(await readFile(`.github/workflows/${name}`, "utf8")) as Workflow;
}

function secretNames(value: unknown): string[] {
  return [...JSON.stringify(value).matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map(
    (match) => match[1] ?? ""
  );
}

test("the deploy job names no central write credential and checks out with the read-only token", async () => {
  const deploy = (await workflow("deploy-source-script.yml")).jobs.deploy;
  assert.ok(deploy);
  const names = secretNames(deploy);
  assert.equal(names.includes("AW_CONTROL_TOKEN"), false);
  assert.equal(names.includes("AW_ADMIN_TOKEN"), false);
  const checkout = deploy.steps?.find((step) => step.name === "Checkout deploy source");
  assert.deepEqual(secretNames(checkout), ["AW_CHECKOUT_TOKEN"]);
  // The environment is requested by the prepare job, which has validated it against the policy.
  assert.match(String(deploy.environment), /needs\.prepare\.outputs\.environment/);
});

test("the deploy entrypoint step applies the central deploy secret policy", async () => {
  const deploy = (await workflow("deploy-source-script.yml")).jobs.deploy;
  const step = deploy?.steps?.find(
    (item) => item.name === "Execute source-owned deploy entrypoint"
  );
  const run = step?.run ?? "";
  assert.match(run, /policies\/deploy-secrets\.json/);
  assert.match(run, /"\$DEPLOY_SOURCE_REPOSITORY" "\$DEPLOY_ENVIRONMENT" deploy/);
  assert.match(run, /AW_CHECKOUT_TOKEN/);
});

test("the prepare job validates the environment against the central policy file", async () => {
  const text = await readFile(".github/workflows/deploy-source-script.yml", "utf8");
  assert.match(
    text,
    /validate-deploy-source\.ts source-script true policies\/runner\.json policies\/deploy-environments\.json/
  );
});

test("every job that uses the admin token runs in the admin-ops environment", async () => {
  const violations: string[] = [];
  for (const name of [
    "apply-repository-settings.yml",
    "security-scan-dispatch.yml",
    "deploy-source-script.yml",
  ]) {
    const parsed = await workflow(name);
    for (const [jobName, job] of Object.entries(parsed.jobs)) {
      const usesAdminToken = (job.steps ?? []).some((step) =>
        secretNames({ env: step.env, with: step.with }).includes("AW_ADMIN_TOKEN")
      );
      if (usesAdminToken && job.environment !== "admin-ops") {
        violations.push(`${name}#${jobName}`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

// --- product keys -------------------------------------------------------------------------------

test("a product key is owner/name/product, and the root layout keeps the repository key", () => {
  assert.equal(productPolicyKey("o/a", "alpha"), "o/a/alpha");
  assert.equal(productPolicyKey("o/a", ""), "o/a");
  for (const key of ["o/a", "o/a/alpha", "o/a/alpha.v2", "o/a/a-b_c"]) {
    assert.equal(isDeployPolicyKey(key), true, key);
  }
  for (const key of ["o/a/*", "o/*", "o/a/", "o/a/-x", "o/a/.., ", "o/a/a/b", "o/a/Alpha b", ""]) {
    assert.equal(isDeployPolicyKey(key), false, key);
  }
});

test("an environment belongs to one key across the whole environment policy", () => {
  assert.doesNotThrow(() =>
    parseDeployEnvironmentPolicy({
      schema_version: 1,
      repositories: {
        "o/a": ["production"],
        "o/a/alpha": ["alpha-prod"],
        "o/a/beta": ["beta-prod"],
      },
    })
  );
  assert.throws(
    () =>
      parseDeployEnvironmentPolicy({
        schema_version: 1,
        repositories: { "o/a": ["production"], "o/a/alpha": ["production"] },
      }),
    /lists environment production under both o\/a and o\/a\/alpha/
  );
});

test("a product key with a wildcard or a malformed key is refused in the environment policy", () => {
  for (const key of ["o/a/*", "o/a/Alpha/extra", "o/a/-alpha", "o/a/alpha/"]) {
    assert.throws(
      () =>
        parseDeployEnvironmentPolicy({
          schema_version: 1,
          repositories: { [key]: ["production"] },
        }),
      /Deploy environment policy entry is invalid/,
      key
    );
  }
});

test("the deploy secret policy refuses wildcard keys and an environment under two keys", async () => {
  await withPolicy(
    { schema_version: 1, deployments: { "o/a/*": { production: { allowed: ["TOKEN_A"] } } } },
    async (path) => {
      await assert.rejects(
        readDeploySecretCeiling(path, "o/a", "production", "alpha"),
        /key is invalid/
      );
    }
  );
  await withPolicy(
    {
      schema_version: 1,
      deployments: {
        "o/a/alpha": { production: { allowed: ["TOKEN_A"] } },
        "o/a/beta": { production: { allowed: ["TOKEN_B"] } },
      },
    },
    async (path) => {
      await assert.rejects(
        readDeploySecretCeiling(path, "o/a", "production", "alpha"),
        /lists environment production under both o\/a\/alpha and o\/a\/beta/
      );
    }
  );
});

test("a product reads only its own deploy secret entry, and a missing product entry is refused", async () => {
  await withPolicy(
    {
      schema_version: 1,
      deployments: {
        "o/a": { production: { allowed: ["REPO_TOKEN"] } },
        "o/a/alpha": { "alpha-prod": { allowed: ["ALPHA_TOKEN"] } },
      },
    },
    async (path) => {
      assert.deepEqual(
        [...(await readDeploySecretCeiling(path, "o/a", "alpha-prod", "alpha"))],
        ["ALPHA_TOKEN"]
      );
      // The product has no fallback to the repository's entry for the same environment.
      assert.equal(
        (await readDeploySecretCeiling(path, "o/a", "production")).has("REPO_TOKEN"),
        true
      );
      assert.equal((await readDeploySecretCeiling(path, "o/a", "production", "alpha")).size, 0);
      await assert.rejects(
        readDeploySecretCeiling(path, "o/a", "production", "gamma", ["TOKEN_X", "TOKEN_Y"]),
        (error: unknown) =>
          error instanceof Error &&
          /no entry for o\/a\/gamma, so the deploy is refused/.test(error.message) &&
          /"o\/a\/gamma": \{[\s\S]*"production": \{[\s\S]*"allowed": \[\s*"TOKEN_X",\s*"TOKEN_Y"\s*\]/.test(
            error.message
          ) &&
          !error.message.includes('"o/a":')
      );
    }
  );
});

test("a product's deploy scope drops another product's secret stored in its environment", async () => {
  const root = await mkdtemp(join(tmpdir(), "deploy-product-scope-"));
  try {
    const baseline = join(root, "baseline");
    const required = join(root, "required");
    const allowed = join(root, "allowed");
    const declaredBeta = join(root, "declared-beta");
    await writeFile(baseline, "PATH\n", "utf8");
    await writeFile(required, "", "utf8");
    await writeFile(allowed, "ALPHA_TOKEN\n", "utf8");
    await writeFile(declaredBeta, "BETA_TOKEN\n", "utf8");
    const policyPath = join(root, "deploy-secrets.json");
    await writeFile(
      policyPath,
      JSON.stringify({
        schema_version: 1,
        deployments: {
          "o/a/alpha": { "alpha-production": { allowed: ["ALPHA_TOKEN"] } },
          "o/a/beta": { "beta-production": { allowed: ["BETA_TOKEN"] } },
        },
      }),
      "utf8"
    );
    // Beta's secret was stored in alpha's GitHub environment by mistake.
    const environment = { PATH: "/bin", ALPHA_TOKEN: "a", BETA_TOKEN: "b" };

    const ceiling = {
      names: await readDeploySecretCeiling(policyPath, "o/a", "alpha-production", "alpha"),
      mode: "enforce" as const,
      label: "deploy" as const,
    };
    const alphaScope = await resolveSecretScope(
      baseline,
      required,
      allowed,
      [],
      environment,
      ceiling
    );
    assert.deepEqual(alphaScope.allowed, ["ALPHA_TOKEN"]);
    assert.deepEqual(alphaScope.unset, ["BETA_TOKEN"]);

    // Alpha cannot declare beta's secret, even though beta's entry lists it.
    await assert.rejects(
      resolveSecretScope(baseline, required, declaredBeta, [], environment, ceiling),
      /outside the central deploy secret policy: BETA_TOKEN/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the shipped policies key every deploying product by its product key", async () => {
  const environments = parseDeployEnvironmentPolicy(
    JSON.parse(await readFile("policies/deploy-environments.json", "utf8"))
  );
  const secrets = JSON.parse(await readFile("policies/deploy-secrets.json", "utf8")) as {
    deployments: Record<string, unknown>;
  };
  assert.deepEqual(Object.keys(environments).sort(), [
    "fongap-labs/ai-gateway",
    "fongap-labs/internal-vault/server-edge",
  ]);
  assert.deepEqual(Object.keys(secrets.deployments).sort(), [
    "fongap-labs/ai-gateway",
    "fongap-labs/internal-vault/server-edge",
  ]);
});

// --- concurrency groups -------------------------------------------------------------------------

// Evaluates a GitHub expression for the subset these groups use: context lookups, format, && and ||.
function evaluate(expression: string, values: Record<string, string | undefined>): string {
  const format = (template: string, ...args: unknown[]) =>
    template.replace(/\{(\d+)\}/g, (_match, index: string) => String(args[Number(index)]));
  const lookup = (name: string) => values[name];
  const source = expression.replace(
    /[A-Za-z_][\w]*(?:\.\w+)+/g,
    (name) => `lookup(${JSON.stringify(name)})`
  );
  return String(new Function("lookup", "format", `return (${source});`)(lookup, format));
}

function renderGroup(template: string, values: Record<string, string | undefined>): string {
  return template.replace(/\$\{\{ (.*?) \}\}/g, (_match, expression: string) =>
    evaluate(expression, values)
  );
}

async function deployGroups(): Promise<{ workflow: string; job: string }> {
  const parsed = parse(await readFile(".github/workflows/deploy-source-script.yml", "utf8")) as {
    concurrency: { group: string };
    jobs: { deploy: { concurrency: { group: string } } };
  };
  return { workflow: parsed.concurrency.group, job: parsed.jobs.deploy.concurrency.group };
}

test("the deploy concurrency group is unique per repository, product and environment", async () => {
  const { workflow } = await deployGroups();
  const group = (product: string | undefined, environment: string) =>
    evaluate(workflow.replace(/^\$\{\{ (.*) \}\}$/, "$1"), {
      "github.event.client_payload.source_repository": "fongap-labs/example",
      "github.event.client_payload.product": product,
      "github.event.client_payload.environment": environment,
    });

  assert.equal(group("", "production"), "source-script-deploy-fongap-labs/example-production");
  assert.equal(
    group("alpha", "production"),
    "source-script-deploy-fongap-labs/example-alpha-production"
  );
  assert.equal(
    group("beta", "production"),
    "source-script-deploy-fongap-labs/example-beta-production"
  );
  assert.equal(group("alpha", "staging"), "source-script-deploy-fongap-labs/example-alpha-staging");
  const groups = new Set([
    group("", "production"),
    group("alpha", "production"),
    group("alpha", "staging"),
  ]);
  assert.equal(groups.size, 3);
});

test("a manual request and the resolved deploy job name the same concurrency group", async () => {
  const { workflow, job } = await deployGroups();
  const fromRequest = evaluate(workflow.replace(/^\$\{\{ (.*) \}\}$/, "$1"), {
    "inputs.source_repository": "fongap-labs/example",
    "inputs.product": "alpha",
    "inputs.environment": "production",
  });
  const fromPrepare = renderGroup(job, {
    "needs.prepare.outputs.source_repository": "fongap-labs/example",
    "needs.prepare.outputs.product": "alpha",
    "needs.prepare.outputs.environment": "production",
  });
  assert.equal(fromRequest, fromPrepare);
  assert.equal(fromPrepare, "source-script-deploy-fongap-labs/example-alpha-production");

  // The root layout has no product segment in either group.
  const rootGroup = renderGroup(job, {
    "needs.prepare.outputs.source_repository": "fongap-labs/example",
    "needs.prepare.outputs.product": "",
    "needs.prepare.outputs.environment": "production",
  });
  assert.equal(rootGroup, "source-script-deploy-fongap-labs/example-production");
});

test("the deploy workflow passes the product to the secret scope and the trigger to the entrypoint", async () => {
  const deploy = (await workflow("deploy-source-script.yml")).jobs.deploy;
  const text = await readFile(".github/workflows/deploy-source-script.yml", "utf8");
  assert.match(
    text,
    /"\$DEPLOY_SOURCE_REPOSITORY" "\$DEPLOY_ENVIRONMENT" deploy "\$DEPLOY_PRODUCT"/
  );
  assert.match(text, /target\/\$\{DEPLOY_PRODUCT_DIRECTORY\}\/deploy\.secrets\.required/);
  assert.match(text, /DEPLOY_TRIGGER: \$\{\{ needs\.prepare\.outputs\.trigger \}\}/);
  assert.match(text, /DEPLOY_PRODUCT: \$\{\{ needs\.prepare\.outputs\.product \}\}/);
  assert.equal(deploy?.environment !== undefined, true);
});
