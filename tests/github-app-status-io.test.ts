import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parse } from "yaml";

type Step = {
  name?: string;
  id?: string;
  if?: string;
  uses?: string;
  with?: Record<string, string>;
  env?: Record<string, string>;
};

test("status-read preflight requires the scoped API token, not the signing secret", async () => {
  const script = await readFile("scripts/validate-control-access.ts", "utf8");
  assert.match(script, /commits\/\$\{head\}\/status/);
  assert.doesNotMatch(script, /process\.env\.AW_STATUS_TOKEN|statusToken/);
  assert.match(script, /Commit Statuses Read is required/);
  for (const path of [
    ".github/workflows/handle-pr-dispatch.yml",
    ".github/workflows/central-ci-dispatch.yml",
  ]) {
    const workflow = parse(await readFile(path, "utf8")) as {
      permissions: Record<string, string>;
      jobs: Record<string, { steps?: Step[] }>;
    };
    const steps = Object.values(workflow.jobs).flatMap((job) => job.steps ?? []);
    const validation = steps.find((step) => step.name === "Validate control credential");
    assert.ok(validation, path);
    assert.equal(validation.env?.AW_STATUS_API_TOKEN, undefined, path);
    assert.equal(validation.env?.AW_STATUS_SIGNING_KEYS, undefined, path);
    assert.equal(workflow.permissions.statuses, "read", path);
  }
});

test("central CI publication signs with stable secret but publishes with scoped App authorization", async () => {
  const workflow = parse(await readFile(".github/workflows/central-ci-dispatch.yml", "utf8")) as {
    jobs: {
      finalize: {
        permissions: Record<string, string>;
        steps: Step[];
      };
    };
  };
  const job = workflow.jobs.finalize;
  const step = (name: string) => {
    const found = job.steps.find((candidate) => candidate.name === name);
    assert.ok(found, name);
    return found;
  };
  const mint = step("Mint status write token");
  assert.equal(mint.uses, "./.github/actions/mint-app-token");
  assert.equal(mint.with?.repositories, "${{ steps.status_scope.outputs.repository_name }}");
  assert.equal(mint.with?.["permission-statuses"], "write");
  assert.deepEqual(
    Object.keys(mint.with ?? {}).filter((key) => key.startsWith("permission-")),
    ["permission-statuses"]
  );
  assert.equal(job.permissions.statuses, "read");
  const publish = step("Publish target status");
  assert.equal(publish.env?.AW_STATUS_API_TOKEN, "${{ steps.status_app.outputs.token }}");
  assert.equal(publish.env?.AW_STATUS_SIGNING_KEYS, "${{ secrets.AW_STATUS_SIGNING_KEYS }}");
  const script = await readFile("scripts/write-commit-status.ts", "utf8");
  assert.match(script, /signedStatusDescription\(/);
  assert.match(script, /runGithubCli\([\s\S]*?apiToken/);
  assert.doesNotMatch(script, /AW_STATUS_TOKEN|signingKey/);
});
