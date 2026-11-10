import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parse } from "yaml";
import { intakeReadRepositoryNames } from "../scripts/repository-policy.ts";

type Step = {
  name?: string;
  id?: string;
  uses?: string;
  env?: Record<string, string>;
  with?: Record<string, string>;
};

test("all seven intake jobs use policy-scoped App reads without personal control PAT", async () => {
  const source = await readFile(".github/workflows/intake.yml", "utf8");
  const workflow = parse(source) as { jobs: Record<string, { steps: Step[] }> };
  assert.doesNotMatch(source, /secrets\.AW_CONTROL_TOKEN/);
  const scopes: Record<string, string> = {
    "pull-requests": "pr_scope",
    "main-ci": "pr_scope",
    "main-writes": "pr_scope",
    "task-sources": "task_scope",
    "task-schedules": "task_scope",
    "deploy-schedules": "deploy_scope",
    "security-scans": "pr_scope",
  };
  for (const [job, scope] of Object.entries(scopes)) {
    const steps = workflow.jobs[job]?.steps ?? [];
    const mint = steps.find((step) => step.name === "Mint scoped intake read token");
    assert.equal(mint?.id, "control_read_app", job);
    assert.equal(mint?.uses, "./.github/actions/mint-app-token");
    assert.equal(mint?.with?.repositories, `\${{ steps.${scope}.outputs.read_repositories_csv }}`);
    assert.deepEqual(
      Object.entries(mint?.with ?? {})
        .filter(([key]) => key.startsWith("permission-"))
        .map(([key, permission]) => [key, permission]),
      [
        ["permission-contents", "read"],
        ["permission-actions", "read"],
        ["permission-pull-requests", "read"],
        ["permission-statuses", "read"],
        ["permission-issues", "read"],
      ],
      job
    );
    assert.ok(
      steps.some(
        (step) => step.env?.AW_CONTROL_TOKEN === "${{ steps.control_read_app.outputs.token }}"
      ),
      job
    );
  }
});

test("intake read scope adds the control repository once while preserving policy order", () => {
  assert.equal(
    intakeReadRepositoryNames("fongap-labs/action-worker", [
      "action-worker",
      "ai-gateway",
      "action-worker",
      "dsh-plugin",
    ]),
    "action-worker,ai-gateway,dsh-plugin"
  );
  assert.equal(
    intakeReadRepositoryNames("fongap-labs/action-worker", ["ai-gateway", "dsh-plugin"]),
    "action-worker,ai-gateway,dsh-plugin"
  );
  assert.equal(intakeReadRepositoryNames("fongap-labs/action-worker", []), "action-worker");
  assert.throws(() => intakeReadRepositoryNames("other-org", ["ai-gateway"]), /control repository/);
  assert.throws(
    () => intakeReadRepositoryNames("fongap-labs/action-worker", ["another-org/repo"]),
    /invalid repository names/
  );
});

test("intake App read scopes never use the old duplicate-prone string concatenation", async () => {
  const source = await readFile(".github/workflows/intake.yml", "utf8");
  assert.doesNotMatch(source, /format\('\{0\},\{1\}', github\.event\.repository\.name/);
  const script = await readFile("scripts/repository-policy.ts", "utf8");
  assert.match(script, /read_repositories_csv=/);
});
