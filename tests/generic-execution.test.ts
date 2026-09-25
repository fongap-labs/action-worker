import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseExecutionCapabilityPolicy } from "../scripts/execution-policy.ts";
import { resolveExecutionPlan } from "../scripts/resolve-execution-plan.ts";
import {
  executePlannedJob,
  substituteExecutionTokens,
} from "../scripts/run-execution-job.ts";

const runnerPolicy = {
  schema_version: 1,
  profiles: {
    "linux-standard": {
      enabled: true,
      backend: "github-hosted",
      trust_domain: "sandbox",
      labels: ["ubuntu-24.04"],
      fallback_profiles: [],
    },
    "windows-build": {
      enabled: true,
      backend: "github-hosted",
      trust_domain: "sandbox",
      labels: ["windows-latest"],
      fallback_profiles: [],
    },
    "trusted-deploy": {
      enabled: false,
      backend: "self-hosted",
      trust_domain: "privileged",
      labels: [],
      fallback_profiles: [],
    },
  },
};

const capabilityPolicy = {
  schema_version: 1,
  capabilities: {
    "source.read": { trust_domains: ["sandbox", "control", "privileged"] },
    "artifact.write": { trust_domains: ["sandbox", "control", "privileged"] },
    "deployment.production": { trust_domains: ["privileged"] },
  },
  operations: {
    ci: ["source.read", "artifact.write"],
    review: ["source.read"],
    build: ["source.read", "artifact.write"],
    release: ["source.read", "artifact.write"],
    deploy: ["source.read", "deployment.production"],
    task: ["source.read", "artifact.write"],
    scheduled: ["source.read", "artifact.write"],
  },
};

test("execution plan resolves abstract runner profiles without repository rules", () => {
  const plan = resolveExecutionPlan({
    schema_version: "1",
    operations: {
      ci: {
        jobs: [
          {
            id: "linux",
            runner_profile: "linux-standard",
            command: ["bash", "{control_root}/.github/scripts/central-ci.sh", "{target_root}"],
            timeout_minutes: 180,
            capability_requests: ["source.read"],
          },
          {
            id: "windows",
            runner_profile: "windows-build",
            command: ["pwsh", "-File", "{control_root}/.github/scripts/central-ci.ps1", "-TargetRoot", "{target_root}"],
            timeout_minutes: 90,
            capability_requests: ["source.read"],
          },
        ],
      },
    },
  }, "ci", runnerPolicy, capabilityPolicy);

  assert.equal(plan.length, 2);
  assert.equal(plan[0]?.runner_backend, "github-hosted");
  assert.equal(plan[0]?.trust_domain, "sandbox");
  assert.equal(plan[0]?.runner_labels_json, JSON.stringify(["ubuntu-24.04"]));
  assert.equal(plan[1]?.runner_labels_json, JSON.stringify(["windows-latest"]));
  assert.doesNotMatch(JSON.stringify(plan), /fongap-labs\//);
});

test("execution plan expands matrix values deterministically", () => {
  const plan = resolveExecutionPlan({
    schema_version: "1",
    operations: {
      build: {
        jobs: [{
          id: "build",
          runner_profile: "linux-standard",
          command: ["build-tool", "--target", "{matrix.target}"],
          timeout_minutes: 30,
          capability_requests: ["source.read", "artifact.write"],
          matrix: {
            target: ["x64", "arm64"],
          },
          artifacts: [{
            name: "package",
            path: "dist/{matrix.target}/package.zip",
            required: true,
          }],
        }],
      },
    },
  }, "build", runnerPolicy, capabilityPolicy);

  assert.deepEqual(plan.map((item) => item.instance_id), [
    "build[target=x64]",
    "build[target=arm64]",
  ]);
  assert.deepEqual(plan.map((item) => JSON.parse(item.command_json)), [
    ["build-tool", "--target", "x64"],
    ["build-tool", "--target", "arm64"],
  ]);
});

test("execution plan fails closed for unavailable privileged runner", () => {
  assert.throws(() => resolveExecutionPlan({
    schema_version: "1",
    operations: {
      deploy: {
        jobs: [{
          id: "deploy",
          runner_profile: "trusted-deploy",
          command: ["deploy-tool"],
          timeout_minutes: 30,
          capability_requests: ["source.read", "deployment.production"],
        }],
      },
    },
  }, "deploy", runnerPolicy, capabilityPolicy));
});

test("execution capability policy rejects cross-operation grants", () => {
  const policy = parseExecutionCapabilityPolicy(capabilityPolicy);
  assert.ok(policy.operations.ci.includes("source.read"));

  assert.throws(() => resolveExecutionPlan({
    schema_version: "1",
    operations: {
      ci: {
        jobs: [{
          id: "ci",
          runner_profile: "linux-standard",
          command: ["true"],
          timeout_minutes: 5,
          capability_requests: ["deployment.production"],
        }],
      },
    },
  }, "ci", runnerPolicy, capabilityPolicy));
});

test("execution tokens are limited to controlled runtime roots", () => {
  const rendered = substituteExecutionTokens(
    "{control_root}/script {target_root} {temp_root}",
    {
      control_root: "/control",
      target_root: "/target",
      temp_root: "/temp",
    },
  );
  assert.equal(rendered, "/control/script /target /temp");
  assert.throws(() => substituteExecutionTokens("{unknown_root}/script", {
    control_root: "/control",
    target_root: "/target",
    temp_root: "/temp",
  }));
});

test("execution job prevents working-directory escape and suppresses private failure detail", async () => {
  const root = await mkdtemp(join(tmpdir(), "action-worker-execution-"));
  const baseJob = {
    job_id: "test",
    instance_id: "test",
    runner_profile: "linux-standard",
    runner_backend: "github-hosted",
    trust_domain: "sandbox",
    runner_labels_json: JSON.stringify(["ubuntu-24.04"]),
    command_json: JSON.stringify(["node", "-e", "process.exit(7)"]),
    working_directory: "",
    timeout_minutes: 1,
    capability_requests_json: JSON.stringify(["source.read"]),
    artifacts_json: "[]",
    matrix_json: "{}",
  };

  try {
    await assert.rejects(
      executePlannedJob(
        { ...baseJob, working_directory: "../escape" },
        { target_root: root, control_root: root, temp_root: root },
        process.env,
      ),
      /escapes target root/,
    );

    await assert.rejects(
      executePlannedJob(
        baseJob,
        { target_root: root, control_root: root, temp_root: root },
        { ...process.env, EXECUTION_TARGET_PRIVATE: "true" },
      ),
      (error: unknown) => {
        assert.match(String(error), /Detailed command output is suppressed/);
        assert.doesNotMatch(String(error), /process\.exit/);
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
