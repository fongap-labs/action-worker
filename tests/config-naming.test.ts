import assert from "node:assert/strict";
import test from "node:test";
import { validateConfigText } from "../scripts/validate-config-naming.ts";

test("accepts context-independent external names", () => {
  assert.deepEqual(
    validateConfigText(".github/workflows/ci.yml", [
      "${{ secrets.AW_CONTROL_TOKEN }}",
      "${{ secrets.AIG_ACCESS_KEY_AIR }}",
      "${{ vars.AI_GATEWAY_URL }}",
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
