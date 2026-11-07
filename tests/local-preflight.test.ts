import assert from "node:assert/strict";
import { test } from "node:test";
import { preflightSteps } from "../scripts/local-preflight.ts";

test("quick local preflight reuses focused existing deterministic checks", () => {
  const steps = preflightSteps("quick");
  assert.deepEqual(
    steps.map(({ command, args }) => [command, ...args].join(" ")),
    [
      "npm run typecheck",
      "npm run lint",
      "node --test tests/workflow-environments.test.ts tests/release-build-manifest.test.ts tests/release-build-attestation-isolation.test.ts",
    ]
  );
});

test("full local preflight does not duplicate or bypass central merge gates", () => {
  assert.deepEqual(preflightSteps("full"), [
    { command: "npm", args: ["run", "check"] },
    { command: "python3", args: ["tests/test-source-naming.py"] },
  ]);
});
