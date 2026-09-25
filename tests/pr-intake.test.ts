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
