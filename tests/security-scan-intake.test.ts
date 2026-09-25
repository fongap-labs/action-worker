import assert from "node:assert/strict";
import { test } from "node:test";
import { scanDefaultBranchSecurity } from "../scripts/intake-security-scans.ts";

const sha = "a".repeat(40);

function encoded(value: unknown): unknown {
  return {
    encoding: "base64",
    content: Buffer.from(JSON.stringify(value)).toString("base64"),
  };
}

test("security scan intake dispatches only repositories with enabled trusted manifests", async () => {
  const dispatched: string[] = [];
  const paths: string[] = [];
  const result = await scanDefaultBranchSecurity(
    {
      "fongap-labs/control": ["pr"],
      "fongap-labs/enabled": ["pr"],
      "fongap-labs/disabled": ["pr"],
      "fongap-labs/no-manifest": ["pr"],
      "fongap-labs/private": ["pr"],
    },
    {
      async get(path: string): Promise<unknown> {
        paths.push(path);
        if (path.endsWith("/enabled")) return { default_branch: "main", private: false };
        if (path.endsWith("/disabled")) return { default_branch: "main", private: false };
        if (path.endsWith("/no-manifest")) return { default_branch: "main", private: false };
        if (path.endsWith("/private")) return { default_branch: "main", private: true };
        if (path.endsWith("/commits/main")) return { sha };
        if (path.includes("/enabled/contents/")) {
          return encoded({
            schema_version: "1",
            engine: "codeql",
            runner_profile: "linux-standard",
            build_mode: "none",
            languages: ["python"],
            pull_requests: true,
            default_branch: true,
          });
        }
        if (path.includes("/disabled/contents/")) {
          return encoded({
            schema_version: "1",
            engine: "codeql",
            runner_profile: "linux-standard",
            build_mode: "none",
            languages: ["python"],
            pull_requests: true,
            default_branch: false,
          });
        }
        throw new Error(`unexpected path: ${path}`);
      },
    },
    async (path) => !path.includes("no-manifest"),
    async (repository) => {
      dispatched.push(repository);
    },
    "fongap-labs/control",
  );

  assert.deepEqual(dispatched, ["fongap-labs/enabled"]);
  assert.equal(result.repositories, 4);
  assert.equal(result.manifests, 2);
  assert.equal(result.dispatched, 1);
  assert.equal(result.skipped, 3);
  assert.equal(paths.some((path) => path.includes("fongap-labs/control")), false);
});
