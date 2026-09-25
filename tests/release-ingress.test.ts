import assert from "node:assert/strict";
import { test } from "node:test";
import {
  normalizeVersion,
  resolveManualReleaseBuild,
} from "../scripts/resolve-release-build-ingress.ts";

const sha = "a".repeat(40);

test("manual release ingress resolves the current default-branch head", async () => {
  const paths: string[] = [];
  const request = await resolveManualReleaseBuild(
    "fongap-labs/example",
    "v1.2.3",
    { "fongap-labs/example": ["release-source"] },
    {
      async get(path: string): Promise<unknown> {
        paths.push(path);
        if (path === "repos/fongap-labs/example") return { default_branch: "main" };
        if (path === "repos/fongap-labs/example/commits/main") return { sha };
        throw new Error(`unexpected path: ${path}`);
      },
    },
    "123",
    "1",
  );

  assert.deepEqual(request, {
    schema_version: "1",
    request_id: "manual:fongap-labs-example:123:1",
    source_repository: "fongap-labs/example",
    source_sha: sha,
    requested_version: "1.2.3",
  });
  assert.deepEqual(paths, [
    "repos/fongap-labs/example",
    "repos/fongap-labs/example/commits/main",
  ]);
});

test("manual release ingress rejects unmanaged repositories and unstable versions", async () => {
  const reader = {
    async get(): Promise<unknown> {
      throw new Error("GitHub should not be queried");
    },
  };

  await assert.rejects(
    resolveManualReleaseBuild(
      "fongap-labs/unmanaged",
      "",
      { "fongap-labs/example": ["release-source"] },
      reader,
      "123",
      "1",
    ),
    /not allowed for release-source/,
  );

  assert.throws(() => normalizeVersion("v1.2.3-rc.1"), /stable SemVer/);
});
