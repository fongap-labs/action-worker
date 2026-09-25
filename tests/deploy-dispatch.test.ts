import assert from "node:assert/strict";
import { test } from "node:test";
import {
  deployEventType,
  isDocsOnly,
  parseDeployPolicy,
} from "../scripts/dispatch-central-deploy.ts";

test("deploy executor registry is adapter-owned and repository-agnostic", () => {
  const policy = {
    schema_version: 2 as const,
    adapters: {
      "cloudflare-worker": { event_type: "run-cloudflare-worker" },
      "source-script": { event_type: "run-source-script" },
    },
  };
  const parsed = parseDeployPolicy(policy);
  assert.deepEqual(parsed, policy);
  assert.equal(deployEventType(parsed, "cloudflare-worker"), "run-cloudflare-worker");
  assert.equal(deployEventType(parsed, "source-script"), "run-source-script");
  assert.equal("repositories" in parsed, false);
  assert.throws(() => parseDeployPolicy({
    ...policy,
    repositories: {},
  }));
  assert.throws(() => parseDeployPolicy({
    schema_version: 2,
    adapters: {
      "source-script": {
        event_type: "run-source-script",
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
