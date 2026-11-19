import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isCommitStatusCapacityError,
  scanOpenPullRequests,
} from "../scripts/intake-open-prs.ts";

const repository = "fongap-labs/example";
const controlRepository = "fongap-labs/action-worker";
const saturatedHead = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const cleanHead = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const capacityError = new Error(
  "gh: Validation failed: This SHA and context has reached the maximum number of statuses. (Validation Failed)"
);

function reader(heads: string[]) {
  return {
    async get(path: string): Promise<unknown> {
      if (path.includes("/pulls?")) {
        return heads.map((sha, index) => ({
          number: index + 1,
          title: "fix: validate capacity",
          head: { sha },
        }));
      }
      if (path.endsWith("/status")) return { statuses: [] };
      throw new Error(`Unexpected GitHub API read: ${path}`);
    },
  };
}

test("GitHub commit status saturation is recognized without treating other failures as capacity", () => {
  assert.equal(isCommitStatusCapacityError(capacityError), true);
  assert.equal(isCommitStatusCapacityError(new Error("HTTP 403: permission denied")), false);
  assert.equal(isCommitStatusCapacityError(new Error("HTTP 422: other validation failure")), false);
});

test("saturated PR head stays blocked while unrelated eligible PRs are still dispatched", async () => {
  const dispatched: number[] = [];
  const reserved: string[] = [];
  const result = await scanOpenPullRequests(
    { [repository]: ["pr"] },
    reader([saturatedHead, cleanHead]),
    async (_repository, number) => {
      dispatched.push(number);
    },
    controlRepository,
    undefined,
    async (_repository, sha) => {
      reserved.push(sha);
      if (sha === saturatedHead) throw capacityError;
    }
  );

  assert.deepEqual(reserved, [saturatedHead, cleanHead]);
  assert.deepEqual(dispatched, [2]);
  assert.equal(result.dispatched, 1);
  assert.equal(result.blocked_status_capacity, 1);
});

test("unexpected status reservation errors still stop intake without dispatch", async () => {
  let dispatched = false;
  await assert.rejects(
    scanOpenPullRequests(
      { [repository]: ["pr"] },
      reader([saturatedHead]),
      async () => {
        dispatched = true;
      },
      controlRepository,
      undefined,
      async () => {
        throw new Error("HTTP 403: permission denied");
      }
    ),
    /HTTP 403/
  );
  assert.equal(dispatched, false);
});
