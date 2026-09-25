import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  jobsForOperation,
  parseExecutionManifest,
  parseExecutionRequest,
} from "../scripts/execution-contract.ts";
import {
  parseRunnerPolicy,
  resolveRunnerProfile,
} from "../scripts/runner-policy.ts";

const sha = "0123456789abcdef0123456789abcdef01234567";

test("execution request is repository-agnostic and exact", () => {
  assert.deepEqual(parseExecutionRequest({
    schema_version: "1",
    request_id: "ci:example:1",
    repository: "fongap-labs/example",
    source_sha: sha,
    operation: "ci",
  }), {
    schema_version: "1",
    request_id: "ci:example:1",
    repository: "fongap-labs/example",
    source_sha: sha,
    operation: "ci",
  });

  assert.throws(() => parseExecutionRequest({
    schema_version: "1",
    request_id: "ci:example:1",
    repository: "fongap-labs/example",
    source_sha: sha,
    operation: "ci",
    runner: "ubuntu-24.04",
  }));
  assert.throws(() => parseExecutionRequest({
    schema_version: "1",
    request_id: "ci:example:1",
    repository: "fongap-labs/example",
    source_sha: "main",
    operation: "ci",
  }));
});

test("execution manifest supports generic multi-runner jobs without infrastructure secrets", () => {
  const manifest = parseExecutionManifest({
    schema_version: "1",
    operations: {
      ci: {
        jobs: [
          {
            id: "linux",
            runner_profile: "linux-standard",
            command: ["bash", ".github/scripts/central-ci.sh"],
            timeout_minutes: 120,
            capability_requests: ["source.read", "artifact.write"],
            artifacts: [{ name: "ci-report", path: "artifacts/ci.json", required: true }],
          },
          {
            id: "windows",
            runner_profile: "windows-build",
            command: ["pwsh", "-File", ".github/scripts/central-ci.ps1"],
            timeout_minutes: 90,
            depends_on: ["linux"],
            capability_requests: ["source.read"],
            matrix: { target: ["x64", "x86"] },
          },
        ],
      },
    },
  });

  assert.equal(jobsForOperation(manifest, "ci").length, 2);
  assert.equal(jobsForOperation(manifest, "ci")[1]?.runner_profile, "windows-build");

  assert.throws(() => parseExecutionManifest({
    schema_version: "1",
    operations: {
      deploy: {
        jobs: [{
          id: "deploy",
          runner_profile: "trusted-deploy",
          command: ["./deploy.sh"],
          timeout_minutes: 30,
          capability_requests: ["deployment.production"],
          secrets: ["PRODUCTION_TOKEN"],
        }],
      },
    },
  }));

  assert.throws(() => parseExecutionManifest({
    schema_version: "1",
    operations: {
      build: {
        jobs: [{
          id: "build",
          runner_profile: "linux-standard",
          command: ["npm", "run", "build"],
          timeout_minutes: 30,
          capability_requests: ["artifact.write"],
          artifacts: [{ name: "dist", path: "../private" }],
        }],
      },
    },
  }));
});

test("execution manifest rejects missing dependencies and cycles", () => {
  assert.throws(() => parseExecutionManifest({
    schema_version: "1",
    operations: {
      ci: {
        jobs: [{
          id: "test",
          runner_profile: "linux-standard",
          command: ["npm", "test"],
          timeout_minutes: 30,
          depends_on: ["missing"],
          capability_requests: [],
        }],
      },
    },
  }));

  assert.throws(() => parseExecutionManifest({
    schema_version: "1",
    operations: {
      ci: {
        jobs: [
          {
            id: "a",
            runner_profile: "linux-standard",
            command: ["true"],
            timeout_minutes: 5,
            depends_on: ["b"],
            capability_requests: [],
          },
          {
            id: "b",
            runner_profile: "linux-standard",
            command: ["true"],
            timeout_minutes: 5,
            depends_on: ["a"],
            capability_requests: [],
          },
        ],
      },
    },
  }));
});

test("runner policy resolves central profiles and keeps reserved self-hosted fail closed", async () => {
  const policy = parseRunnerPolicy(JSON.parse(await readFile("policies/runner.json", "utf8")) as unknown);

  const linux = resolveRunnerProfile(policy, "linux-standard");
  assert.equal(linux.profile.backend, "github-hosted");
  assert.equal(linux.profile.trust_domain, "sandbox");
  assert.deepEqual(linux.profile.labels, ["ubuntu-24.04"]);

  assert.throws(() => resolveRunnerProfile(policy, "trusted-deploy"));
});

test("runner policy permits self-hosted backends but rejects unsafe fallback", () => {
  const policy = parseRunnerPolicy({
    schema_version: 1,
    profiles: {
      "trusted-deploy": {
        enabled: true,
        backend: "self-hosted",
        trust_domain: "privileged",
        labels: ["self-hosted", "trusted"],
        fallback_profiles: [],
      },
    },
  });
  assert.equal(resolveRunnerProfile(policy, "trusted-deploy").profile.backend, "self-hosted");

  assert.throws(() => parseRunnerPolicy({
    schema_version: 1,
    profiles: {
      "trusted-deploy": {
        enabled: false,
        backend: "self-hosted",
        trust_domain: "privileged",
        labels: [],
        fallback_profiles: ["linux-standard"],
      },
      "linux-standard": {
        enabled: true,
        backend: "github-hosted",
        trust_domain: "sandbox",
        labels: ["ubuntu-24.04"],
        fallback_profiles: [],
      },
    },
  }));
});
