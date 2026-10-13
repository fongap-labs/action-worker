import assert from "node:assert/strict";
import { test } from "node:test";
import {
  deployEventType,
  isDocsOnly,
  parseDeployPolicy,
  shouldDeployCurrentMain,
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
  assert.throws(() =>
    parseDeployPolicy({
      ...policy,
      repositories: {},
    })
  );
  assert.throws(() =>
    parseDeployPolicy({
      schema_version: 2,
      adapters: {
        "source-script": {
          event_type: "run-source-script-deploy",
          repository: "fongap-labs/example",
        },
      },
    })
  );
});

test("documentation-only deploy classification is deterministic", () => {
  assert.equal(isDocsOnly(["README.md", "docs/deploy.md"]), true);
  assert.equal(isDocsOnly(["docs/deploy.md", ".github/workflows/deploy.yml"]), false);
  assert.equal(isDocsOnly([]), false);
});

test("a commit overtaken by documentation-only commits deploys the current main instead", () => {
  const files = (...names: string[]) => names.map((filename) => ({ filename }));
  const docsAhead = { status: "ahead", files: files("README.md", "docs/deploy.md") };
  // The newer main would skip itself as documentation-only, so the older change ships with it.
  assert.equal(shouldDeployCurrentMain(docsAhead, true), true);
  // The newer main changes code and deploys after its own central CI.
  const codeAhead = { status: "ahead", files: files("README.md", "src/server.ts") };
  assert.equal(shouldDeployCurrentMain(codeAhead, true), false);
  // Without the documentation rule the newer main always deploys itself.
  assert.equal(shouldDeployCurrentMain(docsAhead, false), false);
  // Main was rewritten rather than extended: the newer main is on its own.
  assert.equal(shouldDeployCurrentMain({ ...docsAhead, status: "diverged" }, true), false);
  // GitHub truncates long comparisons, so a full page may hide code changes.
  const truncated = {
    status: "ahead",
    files: Array.from({ length: 300 }, (_, index) => ({ filename: `docs/${index}.md` })),
  };
  assert.equal(shouldDeployCurrentMain(truncated, true), false);
});
