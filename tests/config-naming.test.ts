import assert from "node:assert/strict";
import test from "node:test";
import { validateConfigText } from "../scripts/validate-config-naming.ts";

test("accepts context-independent external names", () => {
  assert.deepEqual(
    validateConfigText(".github/workflows/ci.yml", [
      "${{ secrets.AW_CONTROL_TOKEN }}",
      "${{ secrets.AIG_ACCESS_KEY_AGENT }}",
      "${{ vars.AI_GATEWAY_URL }}",
      "${{ vars.APP_SOURCE_RELEASE_TARGET_REPOSITORY }}",
      "${{ vars.CLOUDFLARE_ACCOUNT_ID }}",
    ].join("\n")),
    [],
  );
});

test("does not reject semantically complete external names for segment count", () => {
  assert.deepEqual(
    validateConfigText(".env.example", "AIG_ACCESS_KEY_ULTRA=value"),
    [],
  );
});

test("does not classify mode-valued configuration as Boolean", () => {
  assert.deepEqual(
    validateConfigText(".github/workflows/deploy.yml", "${{ vars.AIG_USAGE_INCLUDE_MODE }}"),
    [],
  );
});

test("rejects repository-context-only external names", () => {
  const errors = validateConfigText(".github/workflows/ci.yml", [
    "${{ secrets.GENERIC_TOKEN }}",
    "${{ vars.TARGET_ALLOWLIST }}",
  ].join("\n"));

  assert.equal(errors.filter((error) => error.includes("owning system")).length, 2);
});

test("rejects PAT terminology and non-canonical Boolean names", () => {
  const errors = validateConfigText(".env.example", [
    "AW_DISPATCH_PAT=value",
    "AIG_DEPLOY_ENABLED=true",
  ].join("\n"));

  assert.ok(errors.some((error) => error.includes("instead of PAT")));
  assert.ok(errors.some((error) => error.includes("Boolean configuration")));
});


test("accepts business-owner prefixes derived from scoped paths", () => {
  assert.deepEqual(
    validateConfigText("projects/MarketBrief/.env.variables", [
      "MARKETBRIEF_LLM_URL=value",
      "MARKETBRIEF_OUTPUT_DIR=dist/marketbrief",
    ].join("\n")),
    [],
  );

  assert.deepEqual(
    validateConfigText("services/server-edge/.env.example", "SERVER_EDGE_PROXY_URL=value"),
    [],
  );
});

test("still rejects generic names inside a scoped business config", () => {
  const errors = validateConfigText(
    "projects/MarketBrief/.env.variables",
    "ARTIFACT_REPOSITORY=fongap/external-vault",
  );
  assert.ok(errors.some((error) => error.includes("owning system")));
});
