import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isDocsOnly,
  parseDeployPolicy,
} from "../scripts/dispatch-central-deploy.ts";

test("deploy policy is exact and starts disabled for cutover", () => {
  const policy = {
    schema_version: 1,
    repositories: {
      "fongap-labs/ai-gateway": {
        automatic: false,
        event_type: "run-ai-gateway-deploy",
        ignore_docs_only: true,
      },
    },
  };
  assert.deepEqual(parseDeployPolicy(policy), policy);
  assert.throws(() => parseDeployPolicy({
    ...policy,
    repositories: {
      "fongap-labs/ai-gateway": {
        ...policy.repositories["fongap-labs/ai-gateway"],
        extra: true,
      },
    },
  }));
});

test("documentation-only deploy classification is deterministic", () => {
  assert.equal(isDocsOnly(["README.md", "docs/deploy.md"]), true);
  assert.equal(isDocsOnly(["docs/deploy.md", ".github/workflows/deploy.yml"]), false);
  assert.equal(isDocsOnly([]), false);
});
