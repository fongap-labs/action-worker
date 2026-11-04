import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parse } from "yaml";
import { requireToken } from "../scripts/control-token.ts";
import { GithubHttpError, GithubReader } from "../scripts/github-api.ts";
import { resolveGithubApiScope } from "../scripts/resolve-github-api-scope.ts";

type Step = {
  name?: string;
  id?: string;
  uses?: string;
  with?: Record<string, string>;
  env?: Record<string, string>;
};

async function workflowSteps(file: string): Promise<Step[]> {
  const source = await readFile(`.github/workflows/${file}.yml`, "utf8");
  const workflow = parse(source) as { jobs: Record<string, { steps?: Step[] }> };
  return Object.values(workflow.jobs).flatMap((job) => job.steps ?? []);
}

function requireStep(steps: Step[], name: string, id?: string): Step {
  const found = steps.find((step) => step.name === name && (!id || step.id === id));
  assert.ok(found, `missing ${name}`);
  return found;
}

test("PR Governance retains independently scoped read, status, dispatch and issue tokens", async () => {
  const steps = await workflowSteps("handle-pr-dispatch");
  const read = requireStep(steps, "Mint PR read token");
  assert.equal(read.with?.["permission-contents"], "read");
  assert.equal(read.with?.["permission-pull-requests"], "read");
  assert.equal(read.with?.["permission-actions"], "read");
  assert.equal(read.with?.["permission-statuses"], "read");
  assert.match(read.with?.repositories ?? "", /format\('\{0\},\{1\}'/);
  assert.equal(requireStep(steps, "Mint pending status token").with?.["permission-statuses"], "write");
  assert.equal(
    requireStep(steps, "Mint centralized CI dispatch token").with?.["permission-contents"],
    "write"
  );
  assert.equal(requireStep(steps, "Mint final governance read token").id, "final_read_app");
  assert.equal(requireStep(steps, "Mint unfinished governance read token").id, "unfinished_read_app");
  assert.equal(
    requireStep(steps, "Checkout target PR").with?.token,
    "${{ steps.app_read.outputs.token }}"
  );
});

test("CI, deploy and AI Review independently mint appropriate App permissions", async () => {
  const ci = await workflowSteps("central-ci-dispatch");
  assert.equal(
    requireStep(ci, "Mint cross-repository central CI read token").with?.["permission-actions"],
    "read"
  );
  assert.equal(requireStep(ci, "Mint status write token").with?.["permission-statuses"], "write");
  const deploy = await workflowSteps("deploy-source-script");
  assert.equal(
    requireStep(deploy, "Mint cross-repository deploy preflight read token").with
      ?.["permission-contents"],
    "read"
  );
  assert.equal(
    requireStep(deploy, "Mint source audit status token").with?.["permission-statuses"],
    "write"
  );
  assert.equal(
    requireStep(deploy, "Mint source audit issue token").with?.["permission-issues"],
    "write"
  );
  const review = await workflowSteps("handle-pr-review");
  assert.equal(requireStep(review, "Mint CI evidence read token").with?.["permission-actions"], "read");
  assert.equal(
    requireStep(review, "Mint final PR review read token").with?.["permission-statuses"],
    "read"
  );
  assert.equal(
    requireStep(review, "Publish PR review", "issue_app").with?.["permission-issues"],
    "write"
  );
});

test("unmanaged repositories, cross-owner access and missing App tokens fail closed", () => {
  const policy = { "fongap-labs/delta": ["pr", "deploy"] };
  assert.deepEqual(
    resolveGithubApiScope("fongap-labs/delta", "fongap-labs/action-worker", policy, "pr"),
    { owner: "fongap-labs", repository_name: "delta", is_control_repository: false }
  );
  assert.throws(() =>
    resolveGithubApiScope("fongap-labs/unknown", "fongap-labs/action-worker", policy, "pr")
  );
  assert.throws(() =>
    resolveGithubApiScope(
      "other-org/private",
      "fongap-labs/action-worker",
      { "other-org/private": ["pr"] },
      "pr"
    )
  );
  for (const scope of ["status", "issue", "dispatch", "checkout", "release"] as const) {
    assert.throws(
      () => requireToken(scope, { AW_CONTROL_TOKEN: "personal-pat", GH_TOKEN: "personal-pat" }),
      /No token fallback is permitted/
    );
  }
});

test("expired App credentials (401) are not retried or replaced with a personal token", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_input, init) => {
    calls += 1;
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer expired-app");
    return Response.json({ message: "Bad credentials" }, { status: 401 });
  };
  try {
    const reader = new GithubReader("https://api.github.test", "expired-app", {
      attemptLimit: 3,
      retryDelayMs: 0,
      timeoutMs: 1000,
    });
    await assert.rejects(
      () => reader.get("repos/fongap-labs/delta"),
      (error: unknown) => error instanceof GithubHttpError && error.status === 401
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("unapproved App permissions (403) are distinct from GitHub rate limits", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return Response.json({ message: "Resource not accessible by integration" }, { status: 403 });
  };
  try {
    const reader = new GithubReader("https://api.github.test", "restricted-app", {
      attemptLimit: 3,
      retryDelayMs: 0,
      timeoutMs: 1000,
    });
    await assert.rejects(
      () => reader.get("repos/fongap-labs/delta"),
      (error: unknown) => error instanceof GithubHttpError && error.kind === "permission"
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
