import assert from "node:assert/strict";
import { test } from "node:test";
import { scopedMcpHubVariables } from "../scripts/export-repository-variables.ts";

test("MCP Hub auth mode uses only an explicitly allowlisted public GitHub Variable", () => {
  const values = scopedMcpHubVariables({
    AW_MCP_HUB_VAR_MCP_AUTH_MODE: "cloudflare-mfa",
    AW_MCP_HUB_VAR_MCP_ACCESS_ISSUER: "https://example.cloudflareaccess.com",
    AW_MCP_HUB_VAR_MCP_TOTP_SECRET: "SHOULD_NOT_EXPORT",
    AW_MCP_HUB_VAR_CLOUDFLARE_API_TOKEN_SECONDARY: "SHOULD_NOT_EXPORT",
    AW_MCP_HUB_VAR_UNRELATED: "SHOULD_NOT_EXPORT",
  });
  assert.equal(values.MCP_AUTH_MODE, "cloudflare-mfa");
  assert.equal(values.MCP_ACCESS_ISSUER, "https://example.cloudflareaccess.com");
  for (const forbidden of ["MCP_TOTP_SECRET", "CLOUDFLARE_API_TOKEN_SECONDARY", "UNRELATED"]) {
    assert.equal(Object.hasOwn(values, forbidden), false);
  }
});

test("MCP Hub mode remains absent when not configured", () => {
  const values = scopedMcpHubVariables({});
  assert.equal(Object.hasOwn(values, "MCP_AUTH_MODE"), false);
});
