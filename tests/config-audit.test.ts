import assert from "node:assert/strict";
import { test } from "node:test";
import {
  auditSources,
  parseSecretNames,
  policyDeclarationCheck,
  sourceManifest,
} from "../scripts/config-audit.ts";

test("manifest parser only scans explicit source declarations", () => {
  assert.deepEqual(sourceManifest("projects/demo/.secrets.required"), {
    project: "demo",
    kind: "required",
  });
  assert.equal(sourceManifest("tests/fixtures/projects/demo/.secrets.required"), null);
  assert.equal(sourceManifest("projects/demo/secret.txt"), null);
});

test("declarations reject reserved and duplicate names", () => {
  assert.deepEqual(parseSecretNames("KEY_A\nKEY_A\nAW_ADMIN_TOKEN\nKEY_B # note\n"), {
    names: ["KEY_A", "KEY_B"],
    invalid: 2,
  });
});

test("policy ceiling is not expanded by discovered source manifests", () => {
  const policy = {
    tasks: {
      "fongap-labs/example": {
        demo: {
          required: ["KEY_A"],
          allowed: [],
          aliases: { CLOUDFLARE_ACCESS_KEY: "CLOUDFLARE_API_TOKEN_PRIMARY" },
        },
      },
    },
  };
  assert.deepEqual(
    policyDeclarationCheck(["KEY_A", "KEY_B"], policy, "fongap-labs/example", "demo"),
    { excess: 1, typeReview: 1 }
  );
  assert.deepEqual(policyDeclarationCheck(["KEY_A"], policy, "fongap-labs/example", "other"), {
    excess: 1,
    typeReview: 0,
  });
});

test("audit reads fixed tree and blobs without modifying GitHub configuration", async () => {
  const calls: string[] = [];
  const sha = "a".repeat(40);
  const blob = "b".repeat(40);
  const reader = {
    async get(path: string): Promise<unknown> {
      calls.push(path);
      if (path === "repos/fongap-labs/demo") return { private: true };
      if (path === "repos/fongap-labs/demo/commits/main") {
        return { sha, commit: { tree: { sha } } };
      }
      if (path === `repos/fongap-labs/demo/git/trees/${sha}?recursive=1`) {
        return {
          truncated: false,
          tree: [{ type: "blob", path: "projects/test/.secrets.required", sha: blob }],
        };
      }
      if (path === `repos/fongap-labs/demo/git/blobs/${blob}`) {
        return { encoding: "base64", content: Buffer.from("TEST_KEY\n").toString("base64") };
      }
      throw new Error("Unexpected request");
    },
  };
  const summary = await auditSources(reader, ["fongap-labs/demo"], {
    tasks: { "fongap-labs/demo": { test: { required: ["TEST_KEY"] } } },
  });
  assert.equal(summary.repositories_scanned, 1);
  assert.equal(summary.private_repositories, 1);
  assert.equal(summary.declared_secret_names, 1);
  assert.equal(summary.policy_excess_names, 0);
  assert.equal(summary.storage_presence, "unverified");
  assert.equal(summary.automatic_writes, false);
  assert.ok(calls.every((path) => !/secrets|variables|environments/.test(path)));
});

test("truncated GitHub tree fails closed", async () => {
  const sha = "a".repeat(40);
  await assert.rejects(
    auditSources(
      {
        async get(path: string): Promise<unknown> {
          if (path === "repos/fongap-labs/demo") return { private: false };
          if (path.endsWith("/commits/main")) return { sha, commit: { tree: { sha } } };
          return { truncated: true, tree: [] };
        },
      },
      ["fongap-labs/demo"],
      {}
    ),
    /incomplete/
  );
});
