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
import { readDeploySecretCeiling, resolveSecretScope } from "../scripts/resolve-secret-scope.ts";

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

test("the shipped environment policy parses and covers the two deploying repositories", async () => {
  const policy = parseDeployEnvironmentPolicy(
    JSON.parse(await readFile("policies/deploy-environments.json", "utf8"))
  );
  assert.deepEqual(policy["fongap-labs/ai-gateway"], ["production"]);
  assert.deepEqual(policy["fongap-labs/internal-vault"], ["server-edge-cloud-edge"]);
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
  assert.equal(aiGateway.size, 37);
  const internalVault = await readDeploySecretCeiling(
    "policies/deploy-secrets.json",
    "fongap-labs/internal-vault",
    "server-edge-cloud-edge"
  );
  assert.deepEqual([...internalVault].sort(), [
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
  const deploy = (await workflow("source-script-deploy.yml")).jobs.deploy;
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
  const deploy = (await workflow("source-script-deploy.yml")).jobs.deploy;
  const step = deploy?.steps?.find(
    (item) => item.name === "Execute source-owned deploy entrypoint"
  );
  const run = step?.run ?? "";
  assert.match(run, /policies\/deploy-secrets\.json/);
  assert.match(run, /"\$DEPLOY_SOURCE_REPOSITORY" "\$DEPLOY_ENVIRONMENT" deploy/);
  assert.match(run, /AW_CHECKOUT_TOKEN/);
});

test("the prepare job validates the environment against the central policy file", async () => {
  const text = await readFile(".github/workflows/source-script-deploy.yml", "utf8");
  assert.match(
    text,
    /validate-deploy-source\.ts source-script true policies\/runner\.json policies\/deploy-environments\.json/
  );
});

test("every job that uses the admin token runs in the admin-ops environment", async () => {
  const violations: string[] = [];
  for (const name of ["apply-repo-settings.yml", "security-scan.yml", "source-script-deploy.yml"]) {
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
