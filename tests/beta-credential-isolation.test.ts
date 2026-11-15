import assert from "node:assert/strict";
import { test } from "node:test";
import { assertBetaCredentialScope } from "../scripts/beta-credential-guard.ts";
import { scopedBetaPublicVariables } from "../scripts/export-repository-variables.ts";

test("beta credentials require an exact isolated Environment", () => {
  assert.doesNotThrow(() => assertBetaCredentialScope("ai-gateway-beta", "ai-gateway-beta"));
  assert.doesNotThrow(() => assertBetaCredentialScope("mcp-hub-beta", "mcp-hub-beta"));
  assert.doesNotThrow(() => assertBetaCredentialScope("production", "ai-gateway-ops"));
  assert.throws(() => assertBetaCredentialScope("ai-gateway-beta", "ai-gateway-ops"));
  assert.throws(() => assertBetaCredentialScope("mcp-hub-beta", "ai-gateway-beta"));
  assert.throws(() => assertBetaCredentialScope("../production", "production"));
});

test("beta public Variables never inherit credentials or production slots", () => {
  assert.deepEqual(
    scopedBetaPublicVariables(
      JSON.stringify({ MCP_PUBLIC_URL: "https://mcp-beta.example.test", MCP_D1_ID: "beta-db-id" })
    ),
    { MCP_PUBLIC_URL: "https://mcp-beta.example.test", MCP_D1_ID: "beta-db-id" }
  );
  for (const raw of [
    "",
    "not-json",
    "null",
    "[]",
    JSON.stringify({ CLOUDFLARE_API_TOKEN: "do-not-export" }),
    JSON.stringify({ AW_CONTROL_TOKEN: "do-not-export" }),
    JSON.stringify({ MCP_RUNTIME_KEY: "do-not-export" }),
    JSON.stringify({ MCP_D1_ID: 123 }),
    JSON.stringify({ GITHUB_SHA: "other-commit" }),
    "x".repeat(16_385),
  ]) {
    assert.throws(() => scopedBetaPublicVariables(raw), Error);
  }
});
