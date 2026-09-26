import assert from "node:assert/strict";
import { test } from "node:test";
import { scanMainCi } from "../scripts/intake-main-ci.ts";

const shaA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const shaB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const shaC = "cccccccccccccccccccccccccccccccccccccccc";

test("central CI intake dispatches only default heads without evidence", async () => {
  const responses = new Map<string, unknown>([
    ["repos/fongap-labs/one", { default_branch: "main" }],
    ["repos/fongap-labs/one/commits/main", { sha: shaA }],
    [`repos/fongap-labs/one/commits/${shaA}/status`, { statuses: [] }],
    ["repos/fongap-labs/two", { default_branch: "main" }],
    ["repos/fongap-labs/two/commits/main", { sha: shaB }],
    [`repos/fongap-labs/two/commits/${shaB}/status`, {
      statuses: [{ context: "CI Evidence", state: "pending" }],
    }],
    ["repos/fongap-labs/three", { default_branch: "trunk" }],
    ["repos/fongap-labs/three/commits/trunk", { sha: shaC }],
    [`repos/fongap-labs/three/commits/${shaC}/status`, {
      statuses: [{ context: "CI Evidence", state: "success" }],
    }],
  ]);

  const dispatched: Array<{ repository: string; sha: string }> = [];
  const result = await scanMainCi(
    {
      "fongap-labs/one": ["pr"],
      "fongap-labs/two": ["pr"],
      "fongap-labs/three": ["pr"],
    },
    {
      async get(path: string): Promise<unknown> {
        assert.equal(responses.has(path), true, `unexpected API path: ${path}`);
        return responses.get(path);
      },
    },
    async (repository, sha) => {
      dispatched.push({ repository, sha });
    },
  );

  assert.deepEqual(dispatched, [{ repository: "fongap-labs/one", sha: shaA }]);
  assert.deepEqual(result, {
    repositories: 3,
    dispatched: 1,
    in_flight: 1,
    already_processed: 1,
  });
});

test("central CI intake reserves status before dispatch", async () => {
  const repository = "fongap-labs/example";
  const controlRepository = "fongap-labs/action-worker";
  const events: string[] = [];

  const result = await scanMainCi(
    { [repository]: ["pr"] },
    {
      async get(path: string): Promise<unknown> {
        if (path === `repos/${repository}`) return { default_branch: "main" };
        if (path === `repos/${repository}/commits/main`) return { sha: shaA };
        if (path === `repos/${repository}/commits/${shaA}/status`) return { statuses: [] };
        throw new Error(`unexpected API path: ${path}`);
      },
    },
    async (target, sha) => {
      events.push(`dispatch:${target}:${sha}`);
    },
    controlRepository,
    async (target, sha) => {
      events.push(`reserve:${target}:${sha}`);
    },
  );

  assert.deepEqual(events, [
    `reserve:${repository}:${shaA}`,
    `dispatch:${repository}:${shaA}`,
  ]);
  assert.equal(result.dispatched, 1);
});


test("central CI intake honors a recent reservation after the intake run completes", async () => {
  const repository = "fongap-labs/example";
  const controlRepository = "fongap-labs/action-worker";
  let dispatches = 0;
  const updatedAt = new Date().toISOString();

  const result = await scanMainCi(
    { [repository]: ["pr"] },
    {
      async get(path: string): Promise<unknown> {
        if (path === `repos/${repository}`) return { default_branch: "main" };
        if (path === `repos/${repository}/commits/main`) return { sha: shaA };
        if (path === `repos/${repository}/commits/${shaA}/status`) {
          return {
            statuses: [{
              context: "CI Evidence",
              state: "pending",
              updated_at: updatedAt,
              target_url: "https://github.com/fongap-labs/action-worker/actions/runs/45",
            }],
          };
        }
        if (path === "repos/fongap-labs/action-worker/actions/runs/45") {
          return { status: "completed", conclusion: "success" };
        }
        throw new Error(`unexpected API path: ${path}`);
      },
    },
    async () => {
      dispatches += 1;
    },
    controlRepository,
  );

  assert.equal(dispatches, 0);
  assert.equal(result.in_flight, 1);
});


test("central CI intake retries an expired pending reservation", async () => {
  const repository = "fongap-labs/example";
  const controlRepository = "fongap-labs/action-worker";
  let dispatches = 0;
  const updatedAt = new Date(Date.now() - 180_000).toISOString();

  const result = await scanMainCi(
    { [repository]: ["pr"] },
    {
      async get(path: string): Promise<unknown> {
        if (path === `repos/${repository}`) return { default_branch: "main" };
        if (path === `repos/${repository}/commits/main`) return { sha: shaA };
        if (path === `repos/${repository}/commits/${shaA}/status`) {
          return {
            statuses: [{
              context: "CI Evidence",
              state: "pending",
              updated_at: updatedAt,
              target_url: "https://github.com/fongap-labs/action-worker/actions/runs/46",
            }],
          };
        }
        if (path === "repos/fongap-labs/action-worker/actions/runs/46") {
          return { status: "completed", conclusion: "failure" };
        }
        throw new Error(`unexpected API path: ${path}`);
      },
    },
    async () => {
      dispatches += 1;
    },
    controlRepository,
  );

  assert.equal(dispatches, 1);
  assert.equal(result.dispatched, 1);
});


test("central CI intake treats compatibility evidence as processed", async () => {
  const repository = "fongap-labs/example";
  let dispatches = 0;
  const result = await scanMainCi(
    { [repository]: ["pr"] },
    {
      async get(path: string): Promise<unknown> {
        if (path === `repos/${repository}`) return { default_branch: "main" };
        if (path === `repos/${repository}/commits/main`) return { sha: shaA };
        return { statuses: [{ context: "ci-evidence", state: "failure" }] };
      },
    },
    async () => {
      dispatches += 1;
    },
  );

  assert.equal(dispatches, 0);
  assert.equal(result.already_processed, 1);
});

test("central CI intake excludes the control repository without hardcoded names", async () => {
  const controlRepository = "fongap-labs/control";
  const businessRepository = "fongap-labs/business";
  const dispatched: string[] = [];
  const result = await scanMainCi(
    {
      [controlRepository]: ["pr"],
      [businessRepository]: ["pr"],
    },
    {
      async get(path: string): Promise<unknown> {
        assert.doesNotMatch(path, /fongap-labs\/control/);
        if (path === `repos/${businessRepository}`) return { default_branch: "main" };
        if (path === `repos/${businessRepository}/commits/main`) return { sha: shaA };
        return { statuses: [] };
      },
    },
    async (repository) => {
      dispatched.push(repository);
    },
    controlRepository,
  );

  assert.deepEqual(dispatched, [businessRepository]);
  assert.equal(result.repositories, 1);
});
