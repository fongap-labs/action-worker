import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  parseTaskSecretDeclaration,
  validateTaskSecretAdmission,
} from "../scripts/validate-task-secret-admission.ts";

const repository = "fongap-labs/example";
const ref = "a".repeat(40);
const treeSha = "b".repeat(40);
const requiredSha = "c".repeat(40);
const allowedSha = "d".repeat(40);

async function fixture(
  required: string,
  allowed: string,
  policy: unknown = {
    schema_version: 1,
    tasks: { [repository]: { demo: { required: ["SERVICE_KEY"], allowed: ["OPTIONAL_KEY"] } } },
  },
  entryOverrides: unknown[] | null = null
) {
  const root = await mkdtemp(join(tmpdir(), "task-admission-"));
  const policyPath = join(root, "task-secrets.json");
  await writeFile(policyPath, JSON.stringify(policy));
  const entries = entryOverrides ?? [
    { path: "projects/demo/.secrets.required", mode: "100644", type: "blob", sha: requiredSha },
    { path: "projects/demo/.secrets.allowed", mode: "100644", type: "blob", sha: allowedSha },
  ];
  const calls: string[] = [];
  const reader = {
    async get(path: string): Promise<unknown> {
      calls.push(path);
      if (path === `repos/${repository}/git/commits/${ref}`) return { tree: { sha: treeSha } };
      if (path === `repos/${repository}/git/trees/${treeSha}?recursive=1`) {
        return { truncated: false, tree: entries };
      }
      if (path === `repos/${repository}/git/blobs/${requiredSha}`) {
        return { encoding: "base64", content: Buffer.from(required).toString("base64") };
      }
      if (path === `repos/${repository}/git/blobs/${allowedSha}`) {
        return { encoding: "base64", content: Buffer.from(allowed).toString("base64") };
      }
      throw new Error("Unexpected GitHub API endpoint");
    },
  };
  return { policyPath, reader, calls, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("only pinned blobs are read and no credentials are fetched", async () => {
  const x = await fixture("SERVICE_KEY\n", "OPTIONAL_KEY\n");
  try {
    const result = await validateTaskSecretAdmission(
      x.reader,
      repository,
      "demo",
      ref,
      x.policyPath
    );
    assert.deepEqual(result, {
      required_count: 1,
      allowed_count: 1,
      aliased_count: 0,
      secret_values_read: false,
      repository_policy_modified: false,
    });
    assert.ok(x.calls.every((path) => !path.includes("/actions/secrets")));
    assert.ok(x.calls.every((path) => !path.includes("/environments")));
  } finally {
    await x.cleanup();
  }
});

test("undeclared and overlapping source secrets fail closed", async () => {
  const x = await fixture("SERVICE_KEY\n", "OUTSIDE_POLICY\n");
  try {
    await assert.rejects(
      validateTaskSecretAdmission(x.reader, repository, "demo", ref, x.policyPath),
      /outside the central policy/
    );
  } finally {
    await x.cleanup();
  }
  const y = await fixture("SERVICE_KEY\n", "SERVICE_KEY\n");
  try {
    await assert.rejects(
      validateTaskSecretAdmission(y.reader, repository, "demo", ref, y.policyPath),
      /overlapping/
    );
  } finally {
    await y.cleanup();
  }
});

test("reserved or malformed names are rejected before consuming secrets", () => {
  assert.throws(() => parseTaskSecretDeclaration("AW_ARTIFACT_KEY"), /invalid/);
  assert.throws(() => parseTaskSecretDeclaration("GH_TOKEN"), /invalid/);
  assert.throws(() => parseTaskSecretDeclaration("FOO\nFOO\n"), /duplicate/);
  assert.deepEqual(parseTaskSecretDeclaration("# comment\nSERVICE_KEY\n"), ["SERVICE_KEY"]);
});

test("truncated trees and unsafe manifests are refused", async () => {
  const x = await fixture("SERVICE_KEY\n", "");
  try {
    const original = x.reader.get;
    await assert.rejects(
      validateTaskSecretAdmission(
        {
          async get(path: string) {
            if (path.includes("/git/trees/")) return { truncated: true, tree: [] };
            return original(path);
          },
        },
        repository,
        "demo",
        ref,
        x.policyPath
      ),
      /incomplete/
    );
  } finally {
    await x.cleanup();
  }
  const y = await fixture("SERVICE_KEY\n", "", undefined, [
    { path: "projects/demo/.secrets.required", mode: "120000", type: "blob", sha: requiredSha },
  ]);
  try {
    await assert.rejects(
      validateTaskSecretAdmission(y.reader, repository, "demo", ref, y.policyPath),
      /unsafe/
    );
  } finally {
    await y.cleanup();
  }
});

test("alias sources must be distinct and require central approval", async () => {
  const x = await fixture("SERVICE_KEY\n", "OPTIONAL_KEY\n", {
    schema_version: 1,
    tasks: {
      [repository]: {
        demo: {
          required: ["SERVICE_KEY"],
          allowed: ["OPTIONAL_KEY"],
          aliases: { SERVICE_KEY: "SHARED_KEY", OPTIONAL_KEY: "SHARED_KEY" },
        },
      },
    },
  });
  try {
    await assert.rejects(
      validateTaskSecretAdmission(x.reader, repository, "demo", ref, x.policyPath),
      /alias/
    );
  } finally {
    await x.cleanup();
  }
});
