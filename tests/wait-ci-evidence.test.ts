import assert from "node:assert/strict";
import { test } from "node:test";
import { assertCurrentPullHead, calculateBackoff, waitForCentralStatus } from "../scripts/wait-ci-evidence.ts";

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

test("CI evidence polling honors a 120-minute deadline without a 30-call ceiling", () => {
  const deadlineMs = 120 * 60_000;
  const initialMs = 15_000;
  const maxMs = 60_000;
  let elapsedMs = 0;
  let polls = 0;

  // Virtual-time simulation, no GitHub requests or real sleep.
  while (elapsedMs < deadlineMs) {
    const delay = calculateBackoff(polls + 1, initialMs, maxMs, deadlineMs - elapsedMs, 0);
    assert.ok(delay > 0 && delay <= maxMs);
    elapsedMs += delay;
    polls++;
  }

  assert.equal(elapsedMs, deadlineMs);
  assert.ok(polls >= 120, "a 120-minute wait must not run out after 30 polls");
  assert.equal(calculateBackoff(1, initialMs, maxMs, 45_000, 0), 30_000);
  assert.equal(calculateBackoff(100, initialMs, maxMs, 1_500, 0), 1_500);
});

test("CI evidence polling clips jitter at the remaining time budget", () => {
  for (let i = 0; i < 25; i++) {
    const delay = calculateBackoff(25, 15_000, 60_000, 7_000);
    assert.ok(delay >= 0 && delay <= 7_000);
  }
});
