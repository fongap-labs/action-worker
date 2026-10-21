import assert from "node:assert/strict";
import { test } from "node:test";
import { GithubHttpError } from "../scripts/github-api.ts";
import { resolveManualReleaseBuild } from "../scripts/resolve-release-build-ingress.ts";
import { normalizeReleaseVersion } from "../scripts/validate-release-build-request.ts";

const sha = "a".repeat(40);
const head = "b".repeat(40);

function manifestJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema_version: 1,
    artifact_name: "example-release",
    target_repository: "fongap-labs/example",
    release_key: "example",
    release_name: "Example",
    release_notes: "Example release.",
    license_expression: "Apache-2.0",
    node_version_file: "",
    python_version_file: "",
    sbom_asset: "",
    builds: [
      {
        id: "linux",
        runner_profile: "linux-standard",
        target: "x86_64-linux-gnu",
        script: ".github/scripts/build.ps1",
        assets: ["example.zip"],
        attest_asset: "example.zip",
      },
    ],
    ...overrides,
  });
}

function base64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

// A reader that answers the paths a root-layout release needs and fails on anything else.
function rootLayoutReader(manifest: string, responses: Record<string, unknown> = {}, ref = head) {
  const calls: string[] = [];
  return {
    calls,
    async get(path: string): Promise<unknown> {
      calls.push(path);
      if (path in responses) {
        return responses[path];
      }
      if (path === `repos/fongap-labs/example/contents/projects?ref=${ref}`) {
        throw new GithubHttpError(404);
      }
      if (path === `repos/fongap-labs/example/contents/.github?ref=${ref}`) {
        return [{ name: "release.manifest.json", type: "file", size: manifest.length }];
      }
      if (path === `repos/fongap-labs/example/contents/.github/release.manifest.json?ref=${ref}`) {
        return { encoding: "base64", content: base64(manifest) };
      }
      throw new Error(`unexpected path: ${path}`);
    },
  };
}

function policy(): unknown {
  return { "fongap-labs/example": ["release-source", "release-target"] };
}

test("manual release ingress resolves the current default-branch head", async () => {
  const reader = rootLayoutReader(
    manifestJson(),
    {
      "repos/fongap-labs/example": { default_branch: "main" },
      "repos/fongap-labs/example/commits/main": { sha },
      "repos/fongap-labs/example/tags?per_page=100&page=1": [],
      "repos/fongap-labs/example/commits?sha=main&per_page=100&page=1": [
        { sha: head, message: "fix: a change" },
      ],
    },
    sha
  );
  const request = await resolveManualReleaseBuild(
    "fongap-labs/example",
    "v1.2.3",
    policy(),
    reader,
    "123",
    "1"
  );

  assert.deepEqual(request, {
    schema_version: "1",
    request_id: "manual:fongap-labs-example:123:1",
    source_repository: "fongap-labs/example",
    source_sha: sha,
    requested_version: "1.2.3",
  });
});

test("manual release ingress rejects unmanaged repositories and unstable versions", async () => {
  const reader = rootLayoutReader(manifestJson());
  await assert.rejects(
    resolveManualReleaseBuild(
      "fongap-labs/unmanaged",
      "1.2.3",
      { "fongap-labs/example": ["release-source"] },
      reader,
      "123",
      "1"
    ),
    /not allowed for release-source/
  );

  assert.throws(() => normalizeReleaseVersion("v1.2.3-rc.1"), /stable SemVer/);
});

test("manual release ingress rejects unstable versions before touching the manifest", async () => {
  const reader = rootLayoutReader(manifestJson(), {
    "repos/fongap-labs/example": { default_branch: "main" },
    "repos/fongap-labs/example/commits/main": { sha },
  });
  await assert.rejects(
    resolveManualReleaseBuild("fongap-labs/example", "1.2.3-rc.1", policy(), reader, "123", "1"),
    /stable SemVer/
  );
});

test("an empty requested version proposes the next version from the commit span", async () => {
  const reader = rootLayoutReader(manifestJson(), {
    "repos/fongap-labs/example": { default_branch: "main" },
    "repos/fongap-labs/example/commits/main": { sha: head },
    "repos/fongap-labs/example/tags?per_page=100&page=1": [
      { name: "example-v1.2.3", commit: { sha } },
    ],
    [`repos/fongap-labs/example/commits/${encodeURIComponent("example-v1.2.3")}`]: { sha },
    [`repos/fongap-labs/example/compare/${sha}...${head}`]: {
      total_commits: 2,
      commits: [
        { sha: head, message: "feat: the wide lane" },
        { sha: "c".repeat(40), message: "fix: the narrow lane" },
      ],
    },
  });
  const request = await resolveManualReleaseBuild(
    "fongap-labs/example",
    "",
    policy(),
    reader,
    "123",
    "1"
  );
  assert.equal(request.requested_version, "1.3.0");
  // The curated manifest notes stay the authority, so the request carries no notes.
  assert.equal(request.release_notes, undefined);
});

test("an empty requested version refuses a span without release-worthy changes", async () => {
  const reader = rootLayoutReader(manifestJson(), {
    "repos/fongap-labs/example": { default_branch: "main" },
    "repos/fongap-labs/example/commits/main": { sha: head },
    "repos/fongap-labs/example/tags?per_page=100&page=1": [],
    "repos/fongap-labs/example/commits?sha=main&per_page=100&page=1": [
      { sha: head, message: "docs: the readme" },
    ],
  });
  await assert.rejects(
    resolveManualReleaseBuild("fongap-labs/example", "", policy(), reader, "123", "1"),
    /No release-worthy Conventional Commits/
  );
});

test("an empty manifest release_notes falls back to the computed span notes", async () => {
  const reader = rootLayoutReader(manifestJson({ release_notes: "" }), {
    "repos/fongap-labs/example": { default_branch: "main" },
    "repos/fongap-labs/example/commits/main": { sha: head },
    "repos/fongap-labs/example/tags?per_page=100&page=1": [],
    "repos/fongap-labs/example/commits?sha=main&per_page=100&page=1": [
      { sha: head, message: "feat: the wide lane" },
      { sha: "c".repeat(40), message: "docs: the readme" },
    ],
  });
  const request = await resolveManualReleaseBuild(
    "fongap-labs/example",
    "1.2.3",
    policy(),
    reader,
    "123",
    "1"
  );
  assert.equal(request.release_notes, "- feat: the wide lane");
});

test("manual release ingress passes the product only when one is entered", async () => {
  const webManifest = manifestJson({
    release_key: "web",
    artifact_name: "web-release",
    target_repository: "fongap-labs/example",
    root: "projects/web",
  });
  const apiManifest = manifestJson({
    release_key: "api",
    artifact_name: "api-release",
    root: "projects/api",
  });
  const calls: string[] = [];
  const reader = {
    calls,
    async get(path: string): Promise<unknown> {
      calls.push(path);
      if (path === `repos/fongap-labs/example/contents/projects?ref=${head}`) {
        return [
          { name: "web", type: "dir", size: 0 },
          { name: "api", type: "dir", size: 0 },
        ];
      }
      if (path === `repos/fongap-labs/example/contents/.github?ref=${head}`) {
        return [];
      }
      for (const [product, text] of [
        ["web", webManifest],
        ["api", apiManifest],
      ] as const) {
        if (path === `repos/fongap-labs/example/contents/projects/${product}?ref=${head}`) {
          return [{ name: "release.manifest.json", type: "file", size: text.length }];
        }
        if (
          path ===
          `repos/fongap-labs/example/contents/projects/${product}/release.manifest.json?ref=${head}`
        ) {
          return { encoding: "base64", content: base64(text) };
        }
      }
      if (path === "repos/fongap-labs/example") {
        return { default_branch: "main" };
      }
      if (path === "repos/fongap-labs/example/commits/main") {
        return { sha: head };
      }
      if (path.startsWith("repos/fongap-labs/example/commits/")) {
        return { files: [{ filename: "projects/web/form.ts" }] };
      }
      if (path === "repos/fongap-labs/example/tags?per_page=100&page=1") {
        return [];
      }
      if (path.startsWith("repos/fongap-labs/example/commits?sha=main")) {
        return [{ sha: head, message: "fix: a change" }];
      }
      throw new Error(`unexpected path: ${path}`);
    },
  };
  const policyValue = { "fongap-labs/example": ["release-source", "release-target"] };

  const request = await resolveManualReleaseBuild(
    "fongap-labs/example",
    "1.2.3",
    policyValue,
    reader,
    "123",
    "1",
    "web"
  );
  assert.equal(request.product, "web");

  await assert.rejects(
    resolveManualReleaseBuild(
      "fongap-labs/example",
      "1.2.3",
      policyValue,
      reader,
      "123",
      "1",
      "../web"
    ),
    /Product name is invalid/
  );
});
