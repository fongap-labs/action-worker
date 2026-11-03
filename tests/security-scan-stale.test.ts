import assert from "node:assert/strict";
import { test } from "node:test";
import { isSupersededSecurityScan } from "../scripts/dispatch-security-scan.ts";
import { CliError } from "../scripts/runtime-command.ts";
import { parseSecurityScanRequest, resolveSecurityScanFacts } from "../scripts/security-scan.ts";

const repository = "fongap/example";
const sourceSha = "a".repeat(40);

test("only stale security scan revisions are skipped as superseded", () => {
  assert.equal(
    isSupersededSecurityScan(new CliError("Security scan request is stale", 75)),
    true
  );
  assert.equal(isSupersededSecurityScan(new CliError("invalid PR base", 65)), false);
  assert.equal(isSupersededSecurityScan(new CliError("permission denied", 77)), false);
  assert.equal(isSupersededSecurityScan(new Error("unexpected failure")), false);
});

test("malformed PR base SHA remains a hard security error rather than a stale skip", async () => {
  const request = parseSecurityScanRequest({
    schema_version: "1",
    request_id: "scan-pr-7",
    repository,
    source_sha: sourceSha,
    pr_number: 7,
  });
  await assert.rejects(
    resolveSecurityScanFacts(
      {
        async get(path: string): Promise<unknown> {
          if (path === `repos/${repository}`) {
            return { default_branch: "main", private: false };
          }
          if (path === `repos/${repository}/pulls/7`) {
            return { head: { sha: sourceSha }, base: { sha: "invalid" } };
          }
          throw new Error(`Unexpected API request: ${path}`);
        },
      },
      request
    ),
    (error: unknown) =>
      error instanceof CliError &&
      error.exitCode === 65 &&
      error.message.includes("invalid PR base SHA")
  );
});
