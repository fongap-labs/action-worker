import assert from "node:assert/strict";
import { test } from "node:test";
import { reportSigningSecretAccessError } from "../scripts/bootstrap-status-signing.ts";
import { CliError } from "../scripts/runtime-command.ts";

test("signing bootstrap reports repository Secrets write scope on permission denial", () => {
  assert.throws(
    () =>
      reportSigningSecretAccessError(
        new CliError("gh: Resource not accessible by personal access token (HTTP 403)", 1),
        "fongap-labs/action-worker"
      ),
    (error: unknown) =>
      error instanceof CliError &&
      error.exitCode === 77 &&
      error.message.includes("AW_STATUS_SIGNING_KEYS") &&
      error.message.includes("Secrets: Read and write") &&
      error.message.includes("GitHub App") &&
      error.message.includes("AW_STATUS_TOKEN")
  );
});

test("signing bootstrap does not misclassify API rate-limit failures as missing permissions", () => {
  const primary = new CliError("gh: API rate limit exceeded (HTTP 403)", 1);
  assert.throws(() => reportSigningSecretAccessError(primary, "fongap-labs/action-worker"), (e) => e === primary);
  const secondary = new CliError("gh: secondary rate limit (HTTP 403)", 1);
  assert.throws(
    () => reportSigningSecretAccessError(secondary, "fongap-labs/action-worker"),
    (e) => e === secondary
  );
});

test("signing bootstrap preserves unexpected 404 and network failures", () => {
  const missing = new CliError("gh: Not Found (HTTP 404)", 1);
  assert.throws(
    () => reportSigningSecretAccessError(missing, "fongap-labs/action-worker"),
    (e) => e === missing
  );
  const disconnected = new Error("connection refused");
  assert.throws(
    () => reportSigningSecretAccessError(disconnected, "fongap-labs/action-worker"),
    (e) => e === disconnected
  );
});
