import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseSecurityScanManifest,
  parseSecurityScanRequest,
  resolveSecurityScanFacts,
  scanEnabled,
} from "../scripts/security-scan.ts";

const sourceSha = "a".repeat(40);
const baseSha = "b".repeat(40);

test("security scan manifest is exact and source-owned", () => {
  const manifest = parseSecurityScanManifest({
    schema_version: "1",
    engine: "codeql",
    runner_profile: "linux-standard",
    build_mode: "none",
    languages: ["javascript-typescript", "python"],
    pull_requests: true,
    default_branch: true,
  });
  assert.equal(manifest.runner_profile, "linux-standard");
  assert.equal(scanEnabled(manifest, 7), true);
  assert.equal(scanEnabled(manifest, 0), true);
  assert.throws(() => parseSecurityScanManifest({
    ...manifest,
    runner: "ubuntu-latest",
  }));
  assert.throws(() => parseSecurityScanManifest({
    ...manifest,
    languages: ["unknown"],
  }));
});

test("PR security scans trust base SHA config, never PR head config", async () => {
  const request = parseSecurityScanRequest({
    schema_version: "1",
    request_id: "scan-pr-7",
    repository: "fongap/example",
    source_sha: sourceSha,
    pr_number: 7,
  });
  const facts = await resolveSecurityScanFacts({
    async get(path: string): Promise<unknown> {
      if (path === "repos/fongap/example") return { default_branch: "main", private: false };
      if (path === "repos/fongap/example/pulls/7") {
        return {
          head: { sha: sourceSha },
          base: { sha: baseSha },
        };
      }
      throw new Error(`unexpected path: ${path}`);
    },
  }, request);
  assert.equal(facts.config_ref, baseSha);
  assert.equal(facts.ref, "refs/pull/7/head");
});

test("default branch security scans require the current default head", async () => {
  const request = parseSecurityScanRequest({
    schema_version: "1",
    request_id: "scan-main",
    repository: "fongap/example",
    source_sha: sourceSha,
    pr_number: 0,
  });
  const facts = await resolveSecurityScanFacts({
    async get(path: string): Promise<unknown> {
      if (path === "repos/fongap/example") return { default_branch: "trunk", private: false };
      if (path === "repos/fongap/example/commits/trunk") return { sha: sourceSha };
      throw new Error(`unexpected path: ${path}`);
    },
  }, request);
  assert.equal(facts.config_ref, sourceSha);
  assert.equal(facts.ref, "refs/heads/trunk");

  await assert.rejects(
    resolveSecurityScanFacts({
      async get(path: string): Promise<unknown> {
        if (path === "repos/fongap/example") return { default_branch: "trunk", private: false };
        return { sha: baseSha };
      },
    }, request),
    /default branch has moved/,
  );
});

test("security scan facts carry repository visibility", async () => {
  const request = parseSecurityScanRequest({
    schema_version: "1",
    request_id: "scan-private",
    repository: "fongap/private",
    source_sha: sourceSha,
    pr_number: 0,
  });
  const facts = await resolveSecurityScanFacts({
    async get(path: string): Promise<unknown> {
      if (path === "repos/fongap/private") return { default_branch: "main", private: true };
      if (path === "repos/fongap/private/commits/main") return { sha: sourceSha };
      throw new Error(`unexpected path: ${path}`);
    },
  }, request);
  assert.equal(facts.is_private, true);
});
