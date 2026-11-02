import assert from "node:assert/strict";
import { test } from "node:test";
import { assertCurrentPullHead, waitForCentralStatus } from "../scripts/wait-ci-evidence.ts";

const original = "a".repeat(40);
const updated = "b".repeat(40);
const repository = "example/source";

test("CI polling abandons a superseded pull request before checking stale evidence", async () => {
  const calls: string[] = [];
  await assert.rejects(
    waitForCentralStatus(
      repository,
      original,
      { status_context: "CI Evidence" },
      {
        async get(path: string): Promise<unknown> {
          calls.push(path);
          assert.equal(path, `repos/${repository}/pulls/7`);
          return { state: "open", head: { sha: updated } };
        },
      },
      "example/control",
      5,
      1,
      7
    ),
    /Abandoning obsolete CI wait/
  );
  assert.deepEqual(calls, [`repos/${repository}/pulls/7`]);
});

test("CI polling refuses a closed pull request even when its head is unchanged", async () => {
  await assert.rejects(
    assertCurrentPullHead(
      {
        async get(): Promise<unknown> {
          return { state: "closed", head: { sha: original } };
        },
      },
      repository,
      7,
      original
    ),
    /Abandoning obsolete CI wait/
  );
});

test("CI polling accepts an open pull request at the expected head", async () => {
  await assert.doesNotReject(
    assertCurrentPullHead(
      {
        async get(): Promise<unknown> {
          return { state: "open", head: { sha: original } };
        },
      },
      repository,
      7,
      original
    )
  );
});

test("CI polling fails closed when GitHub returns malformed PR facts", async () => {
  await assert.rejects(
    assertCurrentPullHead(
      {
        async get(): Promise<unknown> {
          return { head: null };
        },
      },
      repository,
      7,
      original
    ),
    /Cannot verify the current pull request revision/
  );
});
