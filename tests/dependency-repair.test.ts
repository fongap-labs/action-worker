import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseDependencyRepairManifest,
  parseDependencyRepairRequest,
  resolveDependencyRepairFacts,
  selectDependencyRepair,
} from "../scripts/dependency-repair.ts";

const sha = "a".repeat(40);
const baseSha = "b".repeat(40);

const manifest = {
  schema_version: "1",
  repairs: [{
    id: "uv-lock",
    adapter: "uv-lock",
    runner_profile: "linux-standard",
    trusted_actor: "dependabot[bot]",
    trigger_paths: ["pyproject.toml"],
    output_paths: ["uv.lock"],
    tool_version: "0.12.3",
    head_prefix: "dependabot/",
    working_directory: ".",
  }],
};

test("dependency repair manifest is exact and source-owned", () => {
  assert.deepEqual(parseDependencyRepairManifest(manifest), manifest);
  assert.throws(() => parseDependencyRepairManifest({
    ...manifest,
    repairs: [{
      ...manifest.repairs[0],
      output_paths: ["../uv.lock"],
    }],
  }));
  assert.throws(() => parseDependencyRepairManifest({
    ...manifest,
    repairs: [{
      ...manifest.repairs[0],
      trigger_paths: ["uv.lock"],
    }],
  }));
});

test("dependency repair request is immutable and PR scoped", () => {
  const request = {
    schema_version: "1",
    request_id: "repair:example:1",
    repository: "fongap-labs/example",
    pr_number: 7,
    head_sha: sha,
  };
  assert.deepEqual(parseDependencyRepairRequest(request), request);
  assert.throws(() => parseDependencyRepairRequest({ ...request, head_sha: "main" }));
  assert.throws(() => parseDependencyRepairRequest({ ...request, pr_number: 0 }));
});

test("dependency repair resolves same-repository open PR facts", async () => {
  const facts = await resolveDependencyRepairFacts({
    async get(path: string): Promise<unknown> {
      if (path.endsWith("/pulls/7")) {
        return {
          state: "open",
          user: { login: "dependabot[bot]" },
          head: {
            sha,
            ref: "dependabot/pip/example-1.2.3",
            repo: { full_name: "fongap-labs/example" },
          },
          base: { sha: baseSha },
        };
      }
      if (path.includes("/pulls/7/files")) {
        return [{ filename: "pyproject.toml" }];
      }
      throw new Error(`unexpected path: ${path}`);
    },
  }, {
    schema_version: "1",
    request_id: "repair:example:1",
    repository: "fongap-labs/example",
    pr_number: 7,
    head_sha: sha,
  });

  assert.equal(facts.actor, "dependabot[bot]");
  assert.equal(facts.base_sha, baseSha);
  assert.deepEqual(facts.changed_paths, ["pyproject.toml"]);
  assert.equal(selectDependencyRepair(parseDependencyRepairManifest(manifest), facts)?.id, "uv-lock");
});

test("dependency repair refuses forked, stale, or untrusted PRs", async () => {
  await assert.rejects(
    resolveDependencyRepairFacts({
      async get(path: string): Promise<unknown> {
        if (path.endsWith("/pulls/7")) {
          return {
            state: "open",
            user: { login: "dependabot[bot]" },
            head: {
              sha,
              ref: "dependabot/pip/example-1.2.3",
              repo: { full_name: "someone/fork" },
            },
            base: { sha: baseSha },
          };
        }
        return [];
      },
    }, {
      schema_version: "1",
      request_id: "repair:example:1",
      repository: "fongap-labs/example",
      pr_number: 7,
      head_sha: sha,
    }),
    /forked PR/,
  );

  const facts = {
    repository: "fongap-labs/example",
    pr_number: 7,
    head_sha: sha,
    head_ref: "feature/not-dependabot",
    base_sha: baseSha,
    actor: "human",
    changed_paths: ["pyproject.toml"],
  };
  assert.equal(selectDependencyRepair(parseDependencyRepairManifest(manifest), facts), null);
});
