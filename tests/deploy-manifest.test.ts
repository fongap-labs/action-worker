import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseDeployManifest,
  resolveDeployManifest,
} from "../scripts/deploy-manifest.ts";

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

  assert.throws(() => parseDeployManifest({
    ...manifest,
    runner: "ubuntu-24.04",
  }));
});

test("deploy manifest requires the source-script adapter and safe entrypoint", () => {
  assert.throws(() => parseDeployManifest({
    schema_version: "1",
    adapter: "source-script",
    automatic: false,
    ignore_docs_only: true,
    runner_profile: "production-deploy",
    environment: "production",
    entrypoint: "../deploy.sh",
  }));
  assert.throws(() => parseDeployManifest({
    schema_version: "1",
    adapter: "cloudflare-worker",
    automatic: true,
    ignore_docs_only: true,
    runner_profile: "production-deploy",
    environment: "production",
    entrypoint: "",
  }));
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
    reader,
  );
  assert.equal(resolved.trust_domain, "privileged");
  assert.equal(resolved.runner_backend, "github-hosted");

  await assert.rejects(
    resolveDeployManifest(
      "fongap-labs/example",
      sha,
      { "fongap-labs/example": ["pr"] },
      runnerPolicy,
      reader,
    ),
    /not allowed for deploy/,
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
      reader,
    ),
    /privileged trust domain/,
  );
});
