import assert from "node:assert/strict";
import { test } from "node:test";
import { squashManagedPull } from "../scripts/managed-pr-squash.ts";

const repository = "fongap-labs/example";
const head = "a".repeat(40);
const write = "b".repeat(40);
const token = "scoped-test-token";

test("shared squash transport uses exact head and ordinary protected PR API", async () => {
  let calls = 0;
  const result = await squashManagedPull(repository, 7, head, token, async (args, credential) => {
    calls++;
    assert.equal(credential, token);
    assert.deepEqual(args, [
      "api",
      "--method",
      "PUT",
      `repos/${repository}/pulls/7/merge`,
      "-f",
      `sha=${head}`,
      "-f",
      "merge_method=squash",
    ]);
    return JSON.stringify({ merged: true, sha: write });
  });
  assert.equal(calls, 1);
  assert.deepEqual(result, { merged: true, sha: write });
});

test("invalid merge identity and missing token fail before any write", async () => {
  const rejectWrite = async (): Promise<string> => assert.fail("unexpected write");
  for (const [repo, number, sha] of [
    ["invalid", 7, head],
    [repository, 0, head],
    [repository, 1.5, head],
    [repository, 7, "main"],
  ] as const) {
    await assert.rejects(squashManagedPull(repo, number, sha, token, rejectWrite));
  }
  await assert.rejects(squashManagedPull(repository, 7, head, "", rejectWrite));
});

test("a rejected or unconfirmed merge never yields a successful receipt", async () => {
  for (const response of [
    { merged: false, sha: write },
    { merged: true, sha: "" },
    { merged: true, sha: "dev" },
    null,
  ]) {
    await assert.rejects(
      squashManagedPull(repository, 7, head, token, async () => JSON.stringify(response)),
      /did not confirm/
    );
  }
  await assert.rejects(
    squashManagedPull(repository, 7, head, token, async () => {
      throw new Error("protected branch rejected");
    }),
    /protected branch rejected/
  );
});
