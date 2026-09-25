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
