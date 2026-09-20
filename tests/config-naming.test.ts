import assert from "node:assert/strict";
import test from "node:test";
import { validateConfigText } from "../scripts/validate-config-naming.ts";

test("accepts canonical configuration names and platform variables", () => {
  assert.deepEqual(
    validateConfigText(".github/workflows/ci.yml", [
      "GATEWAY_KEY_AIR",
      "CONTROL_TOKEN",
      "GITHUB_REPOSITORY_OWNER_ID",
      "GH_TOKEN",
      "RUNNER_TEMP",
    ].join("\n")),
    [],
  );
});

test("rejects long, abbreviated provider, and PAT configuration names", () => {
  const errors = validateConfigText(".github/workflows/ci.yml", [
    "TOO_LONG_CONFIG_NAME",
    "GH_CONTROL_TOKEN",
    "CF_ACCOUNT_ID",
    "ACTION_WORKER_PAT",
  ].join("\n"));

  assert.ok(errors.some((error) => error.includes("exceeds three segments")));
  assert.ok(errors.some((error) => error.includes("must not use the GH_ abbreviation")));
  assert.ok(errors.some((error) => error.includes("must use CLOUDFLARE_")));
  assert.ok(errors.some((error) => error.includes("instead of PAT")));
});
