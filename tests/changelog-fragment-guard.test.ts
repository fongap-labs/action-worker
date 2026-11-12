import assert from "node:assert/strict";
import { test } from "node:test";
import { ensureNoLegacyChangelogFragments } from "../scripts/lib/changelog-fragment-guard.ts";
import { CliError } from "../scripts/runtime-command.ts";

const path = "repos/fongap-labs/example/contents/changelog.d?ref=abc123";
const token = "test-token";
const message = "Legacy changelog.d entries remain; move them to CHANGELOG.md before release.";

test("legacy fragment guard preserves exact repository path and token", async () => {
  let calls = 0;
  await ensureNoLegacyChangelogFragments(path, token, message, async (requested, credential) => {
    calls += 1;
    assert.equal(requested, path);
    assert.equal(credential, token);
    return [
      { type: "file", name: "README.txt" },
      { type: "dir", name: "archive.md" },
    ];
  });
  assert.equal(calls, 1);
});

test("both release callers retain their own legacy error diagnostics", async () => {
  for (const diagnostic of [
    message,
    "::error::Legacy changelog.d entries remain. Move them to CHANGELOG.md in a governed PR before release.",
  ]) {
    await assert.rejects(
      ensureNoLegacyChangelogFragments(path, token, diagnostic, async () => [
        { type: "file", name: "pending.md" },
      ]),
      (error: unknown) =>
        error instanceof CliError && error.exitCode === 65 && error.message === diagnostic
    );
  }
});

test("legacy fragment guard ignores missing folders but rejects unrelated API errors", async () => {
  await assert.doesNotReject(
    ensureNoLegacyChangelogFragments(path, token, message, async () => {
      throw new CliError("HTTP 404: Not Found", 65);
    })
  );
  await assert.rejects(
    ensureNoLegacyChangelogFragments(path, token, message, async () => {
      throw new CliError("HTTP 403: Forbidden", 77);
    }),
    /HTTP 403/
  );
  await assert.rejects(
    ensureNoLegacyChangelogFragments(path, token, message, async () => ({ unexpected: true })),
    CliError
  );
});
