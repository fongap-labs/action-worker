import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { scopedMcpHubVariables } from "../scripts/export-repository-variables.ts";

test("MCP Hub deploy receives only allowlisted nonsecret Variables", () => {
  const variables = scopedMcpHubVariables({
    AW_MCP_HUB_VAR_MCP_ACCESS_AUD: "aud-public",
    AW_MCP_HUB_VAR_CLOUDFLARE_ACCOUNT_ID_SECONDARY: "0123456789abcdef0123456789abcdef",
    AW_MCP_HUB_VAR_MCP_D1_ID: "d1-uuid",
    AW_MCP_HUB_VAR_CLOUDFLARE_API_TOKEN_SECONDARY: "forbidden-variable-value",
    AW_MCP_HUB_VAR_MCP_TOTP_SECRET: "forbidden-totp-value",
    REPOSITORY_VARS_JSON: JSON.stringify({
      CLOUDFLARE_API_TOKEN_SECONDARY: "forbidden-variable-value",
      MCP_TOTP_SECRET: "forbidden-totp-value",
    }),
  });
  assert.deepEqual(variables, {
    CLOUDFLARE_ACCOUNT_ID_SECONDARY: "0123456789abcdef0123456789abcdef",
    MCP_D1_ID: "d1-uuid",
    MCP_ACCESS_AUD: "aud-public",
  });
  assert.equal(variables.CLOUDFLARE_API_TOKEN_SECONDARY, undefined);
  assert.equal(variables.MCP_TOTP_SECRET, undefined);
});

test("MCP Hub deploy cannot evaluate toJSON(vars) or export API Tokens as Variables", () => {
  const workflow = parse(readFileSync(".github/workflows/deploy-source-script.yml", "utf8")) as {
    jobs: Record<string, { steps: Array<{name?:string; if?:string; env?:Record<string,string>; run?:string}> }>;
  };
  const steps = workflow.jobs.deploy?.steps ?? [];
  const normal = steps.find((s) => s.name === "Export scoped deployment variables");
  const mcp = steps.find((s) => s.name === "Export MCP Hub allowlisted Variables");
  assert.equal(normal?.if, "needs.prepare.outputs.source_repository != 'fongap-labs/mcp-hub'");
  assert.equal(mcp?.if, "needs.prepare.outputs.source_repository == 'fongap-labs/mcp-hub'");
  assert.equal(normal?.env?.REPOSITORY_VARS_JSON, "${{ toJSON(vars) }}");
  assert.equal(mcp?.env?.AW_MCP_HUB_VAR_CLOUDFLARE_ACCOUNT_ID_SECONDARY, "${{ vars.CLOUDFLARE_ACCOUNT_ID_SECONDARY }}");
  assert.equal(mcp?.env?.AW_MCP_HUB_VAR_MCP_ACCESS_AUD, "${{ vars.MCP_ACCESS_AUD }}");
  assert.equal(mcp?.env?.REPOSITORY_VARS_JSON, undefined);
  assert.equal(mcp?.env?.AW_MCP_HUB_VAR_CLOUDFLARE_API_TOKEN_SECONDARY, undefined);
  assert.equal(mcp?.env?.AW_MCP_HUB_VAR_MCP_TOTP_SECRET, undefined);
  assert.equal(mcp?.run, "node control/scripts/export-repository-variables.ts");
  assert.equal(Object.keys(mcp?.env ?? {}).length, 10);
});
