import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { resolveOcrDistribution } from "../scripts/resolve-ocr-distribution.ts";
import { CliError } from "../scripts/runtime-command.ts";

const home = "C:\\home\\runner";
const validPolicy = {
  engine: {
    repository: "FongapLabs/ocr-engine",
    version: "1.4.2",
    asset: "ocr-engine-1.4.2-linux-x64.tar.gz",
    sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  },
};

test("valid OCR distribution policy resolves pinned outputs", () => {
  assert.deepEqual(resolveOcrDistribution(validPolicy, home), [
    "repository=FongapLabs/ocr-engine",
    "version=1.4.2",
    "asset=ocr-engine-1.4.2-linux-x64.tar.gz",
    "sha256=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    `cache_dir=${join(home, ".cache", "action-worker", "ocr", "1.4.2")}`,
  ]);
});

test("malformed distribution fields are rejected as a policy error", () => {
  const cases: unknown[] = [
    { ...validPolicy, engine: { ...validPolicy.engine, repository: "no-slash" } },
    { ...validPolicy, engine: { ...validPolicy.engine, repository: "too/many/slashes" } },
    { ...validPolicy, engine: { ...validPolicy.engine, version: "1.2" } },
    { ...validPolicy, engine: { ...validPolicy.engine, asset: "Uppercase-Start.tar.gz" } },
    { ...validPolicy, engine: { ...validPolicy.engine, sha256: "0123456789abcdef" } },
    { engine: {} },
    "not-a-record",
  ];
  for (const policy of cases) {
    assert.throws(
      () => resolveOcrDistribution(policy, home),
      (error: unknown) =>
        error instanceof CliError && error.message === "::error::Invalid OCR distribution policy."
    );
  }
});

test("missing HOME is rejected after the policy validates", () => {
  assert.throws(
    () => resolveOcrDistribution(validPolicy, ""),
    (error: unknown) => error instanceof CliError && error.message === "::error::HOME is required."
  );
});
