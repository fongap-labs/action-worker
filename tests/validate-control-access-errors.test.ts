import assert from "node:assert/strict";
import { test } from "node:test";
import { CliError } from "../scripts/runtime-command.ts";
import { checkAccess } from "../scripts/validate-control-access.ts";

test("control read reports exhausted primary GitHub quota, not missing status permission", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return Response.json(
      { message: "API rate limit exceeded for user ID 1234." },
      {
        status: 403,
        headers: {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": "4102444800",
        },
      }
    );
  };
  try {
    await assert.rejects(
      () =>
        checkAccess(
          "repos/fongap-labs/dsh-plugin/commits/example/status",
          "secret-placeholder",
          "::error::Commit Statuses Read is required."
        ),
      (error: unknown) => {
        assert.ok(error instanceof CliError);
        assert.equal(error.exitCode, 75);
        assert.match(error.message, /primary API quota exhausted/);
        assert.match(error.message, /Reset at/);
        assert.doesNotMatch(error.message, /secret-placeholder|Commit Statuses Read is required/);
        return true;
      }
    );
    assert.equal(calls, 1, "primary quota exhaustion must not trigger repeated requests");
  } finally {
    globalThis.fetch = original;
  }
});

test("control read retains strict permission checks for real authorization failures", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return Response.json({ message: "Resource not accessible by integration" }, { status: 403 });
  };
  try {
    await assert.rejects(
      () =>
        checkAccess(
          "repos/example/repo/actions/runs?per_page=1",
          "secret-placeholder",
          "::error::Actions Read is required."
        ),
      (error: unknown) => {
        assert.ok(error instanceof CliError);
        assert.equal(error.exitCode, 77);
        assert.match(error.message, /Actions Read is required/);
        assert.doesNotMatch(error.message, /secret-placeholder/);
        return true;
      }
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test("control read identifies 401 credentials separately from permission and rate failures", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ message: "Bad credentials" }, { status: 401 });
  try {
    await assert.rejects(
      () =>
        checkAccess(
          "repos/example/repo/pulls/12",
          "secret-placeholder",
          "Pull Requests Read required"
        ),
      (error: unknown) => {
        assert.ok(error instanceof CliError);
        assert.equal(error.exitCode, 77);
        assert.match(error.message, /HTTP 401/);
        assert.doesNotMatch(error.message, /secret-placeholder/);
        return true;
      }
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("valid scoped control reads are not broadened or sent with a second credential", async () => {
  const original = globalThis.fetch;
  const paths: string[] = [];
  globalThis.fetch = async (url, options) => {
    paths.push(String(url));
    const headers = new Headers(options?.headers);
    assert.equal(headers.get("authorization"), "Bearer scoped-test-credential");
    return Response.json({ ok: true });
  };
  try {
    assert.deepEqual(
      await checkAccess(
        "repos/example/repo/commits/abc/status",
        "scoped-test-credential",
        "Status read required"
      ),
      { ok: true }
    );
    assert.deepEqual(paths, ["https://api.github.com/repos/example/repo/commits/abc/status"]);
  } finally {
    globalThis.fetch = original;
  }
});
