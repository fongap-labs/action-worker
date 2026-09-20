import assert from "node:assert/strict";
import test from "node:test";
import { validateConfigText } from "../scripts/validate-config-naming.ts";

test("accepts context-independent configuration names and recognized abbreviations", () => {
  assert.deepEqual(
    validateConfigText(".github/workflows/ci.yml", [
      "ACTION_WORKER_CONTROL_TOKEN",
      "AI_GATEWAY_ACCESS_KEY_AIR",
      "AI_GATEWAY_PUBLIC_URL",
      "CLOUDFLARE_ACCOUNT_ID",
      "GH_TOKEN",
      "GITHUB_REPOSITORY_OWNER_ID",
      "RUNNER_TEMP",
    ].join("\n")),
    [],
  );
});

test("does not reject a semantically complete name for exceeding three segments", () => {
  assert.deepEqual(
    validateConfigText(".github/workflows/ci.yml", "AI_GATEWAY_ACCESS_KEY_ULTRA"),
    [],
  );
});

test("rejects PAT terminology and non-canonical Boolean names", () => {
  const errors = validateConfigText(".github/workflows/ci.yml", [
    "ACTION_WORKER_DISPATCH_PAT",
    "AI_GATEWAY_DEPLOY_ENABLED",
  ].join("\n"));

  assert.ok(errors.some((error) => error.includes("instead of PAT")));
  assert.ok(errors.some((error) => error.includes("Boolean configuration")));
});
