import assert from "node:assert/strict";
import { test } from "node:test";
import {
  deployEventType,
  isDocsOnly,
  parseDeployPolicy,
} from "../scripts/dispatch-central-deploy.ts";

test("deploy executor registry is repository-agnostic and source-script only", () => {
  const policy = {
    schema_version: 2 as const,
    adapters: {
      "source-script": { event_type: "run-source-script-deploy" },
    },
  };
  const parsed = parseDeployPolicy(policy);
  assert.deepEqual(parsed, policy);
  assert.equal(deployEventType(parsed, "source-script"), "run-source-script-deploy");
  assert.equal("repositories" in parsed, false);
  assert.throws(() => parseDeployPolicy({
    ...policy,
    repositories: {},
  }));
  assert.throws(() => parseDeployPolicy({
    schema_version: 2,
    adapters: {
      "source-script": {
        event_type: "run-source-script-deploy",
        repository: "fongap-labs/example",
      },
    },
  }));
});

test("documentation-only deploy classification is deterministic", () => {
  assert.equal(isDocsOnly(["README.md", "docs/deploy.md"]), true);
  assert.equal(isDocsOnly(["docs/deploy.md", ".github/workflows/deploy.yml"]), false);
  assert.equal(isDocsOnly([]), false);
});
