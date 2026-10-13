import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseDeployManifest,
  parseDeployPlan,
  resolveDeployManifest,
  toDeployPlan,
} from "../scripts/deploy-manifest.ts";
import { GithubHttpError } from "../scripts/github-api.ts";

const sha = "0123456789abcdef0123456789abcdef01234567";

const repositoryPolicy = {
  "fongap-labs/example": ["pr", "deploy"],
};

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
    "linux-standard": {
      enabled: true,
      backend: "github-hosted",
      trust_domain: "sandbox",
      labels: ["ubuntu-24.04"],
      fallback_profiles: [],
    },
  },
};

function encoded(value: unknown): unknown {
  return {
    encoding: "base64",
    content: Buffer.from(JSON.stringify(value), "utf8").toString("base64"),
  };
}

test("deploy manifest owns intent but not concrete runner labels or secrets", () => {
  const manifest = parseDeployManifest({
    schema_version: "1",
    adapter: "source-script",
    automatic: false,
    ignore_docs_only: true,
    runner_profile: "production-deploy",
    environment: "production",
    entrypoint: "scripts/deploy.sh",
  });
  assert.equal(manifest.runner_profile, "production-deploy");
  assert.equal("runner" in manifest, false);
  assert.equal("secrets" in manifest, false);

  assert.throws(() =>
    parseDeployManifest({
      ...manifest,
      runner: "ubuntu-24.04",
    })
  );
});

test("deploy manifest requires the source-script adapter and safe entrypoint", () => {
  assert.throws(() =>
    parseDeployManifest({
      schema_version: "1",
      adapter: "source-script",
      automatic: false,
      ignore_docs_only: true,
      runner_profile: "production-deploy",
      environment: "production",
      entrypoint: "../deploy.sh",
    })
  );
  assert.throws(() =>
    parseDeployManifest({
      schema_version: "1",
      adapter: "cloudflare-worker",
      automatic: true,
      ignore_docs_only: true,
      runner_profile: "production-deploy",
      environment: "production",
      entrypoint: "",
    })
  );
});

test("deploy manifest resolution requires explicit deploy capability and privileged runner", async () => {
  const manifest = {
    schema_version: "1",
    adapter: "source-script",
    automatic: false,
    ignore_docs_only: true,
    runner_profile: "production-deploy",
    environment: "production",
    entrypoint: "scripts/deploy.sh",
  };
  const reader = {
    async get(path: string): Promise<unknown> {
      if (path.includes(".github/deploy.json")) return encoded(manifest);
      if (path.includes("scripts/deploy.sh")) return { type: "file" };
      throw new Error(`unexpected path: ${path}`);
    },
  };

  const resolved = await resolveDeployManifest(
    "fongap-labs/example",
    sha,
    repositoryPolicy,
    runnerPolicy,
    reader
  );
  assert.equal(resolved.trust_domain, "privileged");
  assert.equal(resolved.runner_backend, "github-hosted");

  await assert.rejects(
    resolveDeployManifest(
      "fongap-labs/example",
      sha,
      { "fongap-labs/example": ["pr"] },
      runnerPolicy,
      reader
    ),
    /not allowed for deploy/
  );

  await assert.rejects(
    resolveDeployManifest(
      "fongap-labs/example",
      sha,
      repositoryPolicy,
      {
        schema_version: 1,
        profiles: {
          "production-deploy": {
            enabled: true,
            backend: "github-hosted",
            trust_domain: "sandbox",
            labels: ["ubuntu-24.04"],
            fallback_profiles: [],
          },
        },
      },
      reader
    ),
    /privileged trust domain/
  );
});

// --- schema 2 and products -----------------------------------------------------------------------

const schemaOne = {
  schema_version: "1",
  adapter: "source-script",
  automatic: true,
  ignore_docs_only: true,
  runner_profile: "production-deploy",
  environment: "production",
  entrypoint: "scripts/deploy.sh",
};

const schemaTwo = {
  schema_version: "2",
  adapter: "source-script",
  root: "projects/alpha",
  entrypoint: "projects/alpha/deploy.sh",
  runner_profile: "production-deploy",
  ignore_docs_only: true,
  environments: {
    production: { triggers: { push: true } },
    staging: {
      triggers: {
        push: { paths: ["projects/alpha/**", "shared/lib/**"] },
        schedule: ["0 3 * * *"],
      },
    },
    manual: {},
  },
};

// A reader that serves the given files and answers 404 for anything else, as the contents API does.
function contentsReader(files: Record<string, unknown>) {
  return {
    async get(path: string): Promise<unknown> {
      const [file = ""] = path.split("?");
      const served = Object.keys(files).find((name) => file.endsWith(`/contents/${name}`));
      if (served !== undefined) return encoded(files[served]);
      if (path.includes("deploy.sh")) return { type: "file" };
      throw new GithubHttpError(404);
    },
  };
}

test("schema 1 keeps its meaning: automatic is a push on the whole repository, and false is manual only", () => {
  const automatic = toDeployPlan(parseDeployManifest(schemaOne));
  assert.equal(automatic.schema_version, "1");
  assert.equal(automatic.root, "");
  assert.deepEqual(automatic.environments, [
    { environment: "production", push_paths: ["**"], schedule: [], declares_triggers: false },
  ]);

  const manual = toDeployPlan(parseDeployManifest({ ...schemaOne, automatic: false }));
  assert.deepEqual(manual.environments[0]?.push_paths, null);
});

test("schema 2 converts each environment's triggers into path patterns", () => {
  const plan = toDeployPlan(parseDeployManifest(schemaTwo));
  assert.equal(plan.schema_version, "2");
  assert.deepEqual(plan.environments, [
    {
      environment: "production",
      push_paths: ["projects/alpha/**"],
      schedule: [],
      declares_triggers: true,
    },
    {
      environment: "staging",
      push_paths: ["projects/alpha/**", "shared/lib/**"],
      schedule: ["0 3 * * *"],
      declares_triggers: true,
    },
    { environment: "manual", push_paths: null, schedule: [], declares_triggers: false },
  ]);

  const rootPlan = toDeployPlan(
    parseDeployManifest({
      ...schemaTwo,
      root: "",
      environments: { production: { triggers: { push: true } } },
    })
  );
  assert.deepEqual(rootPlan.environments[0]?.push_paths, ["**"]);
});

test("schema 2 rejects malformed manifests", () => {
  const withEnvironments = (environments: unknown) => ({ ...schemaTwo, environments });
  const invalid: unknown[] = [
    { ...schemaTwo, extra: true },
    { ...schemaTwo, root: "../escape" },
    { ...schemaTwo, root: "/absolute" },
    withEnvironments({}),
    withEnvironments({ Production: {} }),
    withEnvironments({ production: { triggers: {} } }),
    withEnvironments({ production: { triggers: { deploy: true } } }),
    withEnvironments({ production: { triggers: { push: false } } }),
    withEnvironments({ production: { triggers: { push: { paths: [] } } } }),
    withEnvironments({ production: { triggers: { push: { paths: ["**"] } } } }),
    withEnvironments({ production: { triggers: { push: { paths: ["a/*"] } } } }),
    withEnvironments({ production: { triggers: { push: { paths: ["../x/**"] } } } }),
    withEnvironments({ production: { triggers: { schedule: ["not a cron"] } } }),
    withEnvironments({ production: { triggers: { push: true }, automatic: true } }),
  ];
  for (const value of invalid) {
    assert.throws(() => parseDeployManifest(value), Error, JSON.stringify(value));
  }
});

test("a product's manifest is read from its own directory and names its environment", async () => {
  const reader = contentsReader({
    "projects/alpha/deploy.json": schemaTwo,
  });
  const resolved = await resolveDeployManifest(
    "fongap-labs/example",
    sha,
    repositoryPolicy,
    runnerPolicy,
    reader,
    undefined,
    { product: "alpha", environment: "production" }
  );
  assert.equal(resolved.product, "alpha");
  assert.equal(resolved.product_directory, "projects/alpha");
  assert.equal(resolved.environment, "production");
  assert.equal(resolved.automatic, true);
  assert.deepEqual(resolved.push_paths, ["projects/alpha/**"]);
  assert.equal(resolved.declares_triggers, true);

  const manual = await resolveDeployManifest(
    "fongap-labs/example",
    sha,
    repositoryPolicy,
    runnerPolicy,
    reader,
    undefined,
    { product: "alpha", environment: "manual" }
  );
  assert.equal(manual.automatic, false);

  await assert.rejects(
    resolveDeployManifest(
      "fongap-labs/example",
      sha,
      repositoryPolicy,
      runnerPolicy,
      reader,
      undefined,
      {
        product: "alpha",
      }
    ),
    /Deploy environment is required because the manifest declares several/
  );
  await assert.rejects(
    resolveDeployManifest(
      "fongap-labs/example",
      sha,
      repositoryPolicy,
      runnerPolicy,
      reader,
      undefined,
      {
        product: "alpha",
        environment: "admin-ops",
      }
    ),
    /does not declare environment admin-ops/
  );
  await assert.rejects(
    resolveDeployManifest(
      "fongap-labs/example",
      sha,
      repositoryPolicy,
      runnerPolicy,
      reader,
      undefined,
      {
        product: "../alpha",
      }
    ),
    /Deploy product name is invalid/
  );
});

test("the root layout still reads .github/deploy.json when no product is named", async () => {
  const reader = contentsReader({ ".github/deploy.json": schemaOne });
  const resolved = await resolveDeployManifest(
    "fongap-labs/example",
    sha,
    repositoryPolicy,
    runnerPolicy,
    reader
  );
  assert.equal(resolved.product_directory, ".github");
  assert.equal(resolved.environment, "production");
});

test("a product's environment is refused without a fallback to the repository key", async () => {
  const reader = contentsReader({ "projects/alpha/deploy.json": schemaTwo });
  const environmentPolicy = {
    schema_version: 1,
    repositories: { "fongap-labs/example": ["production"] },
  };
  await assert.rejects(
    resolveDeployManifest(
      "fongap-labs/example",
      sha,
      repositoryPolicy,
      runnerPolicy,
      reader,
      environmentPolicy,
      {
        product: "alpha",
        environment: "production",
      }
    ),
    (error: unknown) =>
      error instanceof Error &&
      /not allowed for fongap-labs\/example\/alpha: production/.test(error.message) &&
      /"fongap-labs\/example\/alpha": \["production"\]/.test(error.message)
  );

  const granted = {
    schema_version: 1,
    repositories: { "fongap-labs/example/alpha": ["production"] },
  };
  const resolved = await resolveDeployManifest(
    "fongap-labs/example",
    sha,
    repositoryPolicy,
    runnerPolicy,
    reader,
    granted,
    { product: "alpha", environment: "production" }
  );
  assert.equal(resolved.environment, "production");
});

test("a plan parsed from text keeps the environments in declared order", () => {
  const plan = parseDeployPlan(JSON.stringify(schemaTwo), "fongap-labs/example");
  assert.deepEqual(
    plan.environments.map((item) => item.environment),
    ["production", "staging", "manual"]
  );
});
