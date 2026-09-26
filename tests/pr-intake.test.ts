import assert from "node:assert/strict";
import { test } from "node:test";
import { scanOpenPullRequests } from "../scripts/intake-open-prs.ts";

const shaA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const shaB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const shaC = "cccccccccccccccccccccccccccccccccccccccc";

test("central PR intake scans every managed repository independent of visibility", async () => {
  const responses = new Map<string, unknown>([
    ["repos/fongap-labs/public-one/pulls?state=open&per_page=100&page=1", [
      { number: 11, head: { sha: shaA } },
    ]],
    ["repos/fongap-labs/private-one/pulls?state=open&per_page=100&page=1", [
      { number: 12, head: { sha: shaB } },
      { number: 13, head: { sha: shaC } },
    ]],
    [`repos/fongap-labs/public-one/commits/${shaA}/status`, { statuses: [] }],
    [`repos/fongap-labs/private-one/commits/${shaB}/status`, {
      statuses: [{
        context: "PR Governance",
        state: "pending",
        target_url: "https://github.com/fongap-labs/action-worker/actions/runs/12",
      }],
    }],
    ["repos/fongap-labs/action-worker/actions/runs/12", {
      status: "in_progress",
    }],
    [`repos/fongap-labs/private-one/commits/${shaC}/status`, {
      statuses: [
        {
          context: "PR Governance",
          state: "failure",
          target_url: "https://github.com/fongap-labs/action-worker/actions/runs/13",
        },
        {
          context: "CI Evidence",
          state: "failure",
          target_url: "https://github.com/fongap-labs/action-worker/actions/runs/13",
        },
        {
          context: "validate-merge",
          state: "failure",
          target_url: "https://github.com/fongap-labs/action-worker/actions/runs/13",
        },
      ],
    }],
  ]);

  const dispatched: Array<{ repository: string; pr: number; sha: string }> = [];
  const result = await scanOpenPullRequests(
    {
      "fongap-labs/public-one": ["pr"],
      "fongap-labs/private-one": ["pr"],
    },
    {
      async get(path: string): Promise<unknown> {
        assert.equal(responses.has(path), true, `unexpected API path: ${path}`);
        return responses.get(path);
      },
    },
    async (repository, pr, sha) => {
      dispatched.push({ repository, pr, sha });
    },
    "fongap-labs/action-worker",
  );

  assert.deepEqual(dispatched, [{
    repository: "fongap-labs/public-one",
    pr: 11,
    sha: shaA,
  }]);
  assert.deepEqual(result, {
    repositories: 2,
    open_pull_requests: 3,
    dispatched: 1,
    repair_dispatched: 0,
    repair_blocked: 0,
    in_flight: 1,
    already_processed: 1,
  });
});

test("central PR intake re-dispatches incomplete non-pending state", async () => {
  const repository = "fongap-labs/example";
  const sha = shaA;
  const dispatched: number[] = [];

  await scanOpenPullRequests(
    { [repository]: ["pr"] },
    {
      async get(path: string): Promise<unknown> {
        if (path.includes("/pulls?")) {
          return [{ number: 5, head: { sha } }];
        }
        return {
          statuses: [{
            context: "CI Evidence",
            state: "success",
            target_url: "https://github.com/fongap-labs/action-worker/actions/runs/5",
          }],
        };
      },
    },
    async (_repository, pr) => {
      dispatched.push(pr);
    },
    "fongap-labs/action-worker",
  );

  assert.deepEqual(dispatched, [5]);
});

test("central PR intake ignores business-repository pending statuses", async () => {
  const repository = "fongap-labs/example";
  const dispatched: number[] = [];

  const result = await scanOpenPullRequests(
    { [repository]: ["pr"] },
    {
      async get(path: string): Promise<unknown> {
        if (path.includes("/pulls?")) {
          return [{ number: 9, head: { sha: shaA } }];
        }
        return {
          statuses: [{
            context: "PR Governance",
            state: "pending",
            target_url: "https://github.com/fongap-labs/example/actions/runs/99",
          }],
        };
      },
    },
    async (_repository, pr) => {
      dispatched.push(pr);
    },
    "fongap-labs/action-worker",
  );

  assert.deepEqual(dispatched, [9]);
  assert.equal(result.in_flight, 0);
  assert.equal(result.dispatched, 1);
});

test("central PR intake excludes the control repository without hardcoded names", async () => {
  const controlRepository = "fongap-labs/control";
  const businessRepository = "fongap-labs/business";
  const dispatched: string[] = [];

  const result = await scanOpenPullRequests(
    {
      [controlRepository]: ["pr"],
      [businessRepository]: ["pr"],
    },
    {
      async get(path: string): Promise<unknown> {
        assert.doesNotMatch(path, /fongap-labs\/control/);
        if (path.includes("/pulls?")) {
          return [{ number: 3, head: { sha: shaA } }];
        }
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
  assert.equal(result.open_pull_requests, 1);
});

test("central PR intake retries stale pending control-plane runs", async () => {
  const repository = "fongap-labs/example";
  const dispatched: number[] = [];

  const result = await scanOpenPullRequests(
    { [repository]: ["pr"] },
    {
      async get(path: string): Promise<unknown> {
        if (path.includes("/pulls?")) {
          return [{ number: 17, head: { sha: shaA } }];
        }
        if (path.endsWith("/status")) {
          return {
            statuses: [
              {
                context: "PR Governance",
                state: "pending",
                target_url: "https://github.com/fongap-labs/action-worker/actions/runs/44",
              },
              {
                context: "CI Evidence",
                state: "pending",
                target_url: "https://github.com/fongap-labs/action-worker/actions/runs/44",
              },
              {
                context: "validate-merge",
                state: "pending",
                target_url: "https://github.com/fongap-labs/action-worker/actions/runs/44",
              },
            ],
          };
        }
        if (path === "repos/fongap-labs/action-worker/actions/runs/44") {
          return { status: "completed", conclusion: "cancelled" };
        }
        throw new Error(`unexpected API path: ${path}`);
      },
    },
    async (_repository, pr) => {
      dispatched.push(pr);
    },
    "fongap-labs/action-worker",
  );

  assert.deepEqual(dispatched, [17]);
  assert.equal(result.in_flight, 0);
  assert.equal(result.dispatched, 1);
});



test("central PR intake honors a recent queued reservation after the intake run completes", async () => {
  const repository = "fongap-labs/example";
  const dispatched: number[] = [];
  const updatedAt = new Date().toISOString();

  const result = await scanOpenPullRequests(
    { [repository]: ["pr"] },
    {
      async get(path: string): Promise<unknown> {
        if (path.includes("/pulls?")) {
          return [{ number: 18, head: { sha: shaA } }];
        }
        if (path.endsWith("/status")) {
          return {
            statuses: [{
              context: "PR Governance",
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
    async (_repository, pr) => {
      dispatched.push(pr);
    },
    "fongap-labs/action-worker",
  );

  assert.deepEqual(dispatched, []);
  assert.equal(result.in_flight, 1);
  assert.equal(result.dispatched, 0);
});


test("central PR intake reserves governance before dispatch", async () => {
  const repository = "fongap-labs/example";
  const events: string[] = [];

  const result = await scanOpenPullRequests(
    { [repository]: ["pr"] },
    {
      async get(path: string): Promise<unknown> {
        if (path.includes("/pulls?")) {
          return [{ number: 19, head: { sha: shaA } }];
        }
        if (path.endsWith("/status")) {
          return { statuses: [] };
        }
        throw new Error(`unexpected API path: ${path}`);
      },
    },
    async (_repository, pr) => {
      events.push(`dispatch:${pr}`);
    },
    "fongap-labs/action-worker",
    undefined,
    "",
    async (_repository, sha, context) => {
      events.push(`reserve:${context}:${sha}`);
    },
  );

  assert.deepEqual(events, [
    `reserve:PR Governance:${shaA}`,
    "dispatch:19",
  ]);
  assert.equal(result.dispatched, 1);
});


test("central PR intake retries failed governance from an older control revision", async () => {
  const repository = "fongap-labs/example";
  const controlRepository = "fongap-labs/action-worker";
  const oldControlSha = shaB;
  const currentControlSha = shaC;
  const dispatched: number[] = [];

  const result = await scanOpenPullRequests(
    { [repository]: ["pr"] },
    {
      async get(path: string): Promise<unknown> {
        if (path.includes("/pulls?")) {
          return [{ number: 31, head: { sha: shaA } }];
        }
        if (path.endsWith(`/commits/${shaA}/status`)) {
          return {
            statuses: ["PR Governance", "CI Evidence", "validate-merge"].map((context) => ({
              context,
              state: "failure",
              target_url: `https://github.com/${controlRepository}/actions/runs/51`,
            })),
          };
        }
        if (path === `repos/${controlRepository}/actions/runs/51`) {
          return {
            status: "completed",
            conclusion: "failure",
            head_sha: oldControlSha,
          };
        }
        throw new Error(`unexpected API path: ${path}`);
      },
    },
    async (_repository, pr) => {
      dispatched.push(pr);
    },
    controlRepository,
    undefined,
    currentControlSha,
  );

  assert.deepEqual(dispatched, [31]);
  assert.equal(result.dispatched, 1);
  assert.equal(result.already_processed, 0);
});


test("central PR intake does not loop failed governance from the current control revision", async () => {
  const repository = "fongap-labs/example";
  const controlRepository = "fongap-labs/action-worker";
  const currentControlSha = shaC;
  const dispatched: number[] = [];

  const result = await scanOpenPullRequests(
    { [repository]: ["pr"] },
    {
      async get(path: string): Promise<unknown> {
        if (path.includes("/pulls?")) {
          return [{ number: 32, head: { sha: shaA } }];
        }
        if (path.endsWith(`/commits/${shaA}/status`)) {
          return {
            statuses: ["PR Governance", "CI Evidence", "validate-merge"].map((context) => ({
              context,
              state: "failure",
              target_url: `https://github.com/${controlRepository}/actions/runs/52`,
            })),
          };
        }
        if (path === `repos/${controlRepository}/actions/runs/52`) {
          return {
            status: "completed",
            conclusion: "failure",
            head_sha: currentControlSha,
          };
        }
        throw new Error(`unexpected API path: ${path}`);
      },
    },
    async (_repository, pr) => {
      dispatched.push(pr);
    },
    controlRepository,
    undefined,
    currentControlSha,
  );

  assert.deepEqual(dispatched, []);
  assert.equal(result.dispatched, 0);
  assert.equal(result.already_processed, 1);
});

test("central PR intake routes matching source-owned dependency repair before governance", async () => {
  const repository = "fongap-labs/example";
  const baseSha = shaB;
  const repairManifest = {
    schema_version: "1",
    repairs: [{
      id: "uv-lock",
      adapter: "uv-lock",
      runner_profile: "linux-standard",
      trusted_actor: "dependabot[bot]",
      trigger_paths: ["pyproject.toml"],
      output_paths: ["uv.lock"],
      tool_version: "0.12.3",
      head_prefix: "dependabot/",
      working_directory: ".",
    }],
  };
  const governance: number[] = [];
  const repairs: number[] = [];
  const reservations: string[] = [];

  const result = await scanOpenPullRequests(
    { [repository]: ["pr"] },
    {
      async get(path: string): Promise<unknown> {
        if (path.includes("/pulls?")) {
          return [{ number: 21, head: { sha: shaA } }];
        }
        if (path.endsWith(`/commits/${shaA}/status`)) {
          return { statuses: [] };
        }
        if (path.endsWith("/pulls/21")) {
          return {
            state: "open",
            user: { login: "dependabot[bot]" },
            head: {
              sha: shaA,
              ref: "dependabot/pip/example-1.2.3",
              repo: { full_name: repository },
            },
            base: { sha: baseSha },
          };
        }
        if (path.includes("/pulls/21/files")) {
          return [{ filename: "pyproject.toml" }];
        }
        if (path === `repos/${repository}/contents/.github/dependency-repair.json?ref=${baseSha}`) {
          return {
            encoding: "base64",
            content: Buffer.from(JSON.stringify(repairManifest), "utf8").toString("base64"),
          };
        }
        throw new Error(`unexpected API path: ${path}`);
      },
    },
    async (_repository, pr) => {
      governance.push(pr);
    },
    "fongap-labs/action-worker",
    async (_repository, pr) => {
      repairs.push(pr);
    },
    "",
    async (_repository, sha, context) => {
      reservations.push(`${context}:${sha}`);
    },
  );

  assert.deepEqual(governance, []);
  assert.deepEqual(repairs, [21]);
  assert.deepEqual(reservations, [`Dependency Repair:${shaA}`]);
  assert.equal(result.dispatched, 0);
  assert.equal(result.repair_dispatched, 1);
  assert.equal(result.repair_blocked, 0);
});
