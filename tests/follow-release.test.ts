import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import {
  followLockFolders,
  parseFollowLockRequest,
  patchWithFinalNewline,
  validateLockPatch,
} from "../scripts/commit-follow-lock.ts";
import {
  type FollowRelease,
  followBranchName,
  followProjectDirectory,
  pinValueFor,
  planFollowChanges,
} from "../scripts/dispatch-follow-updates.ts";
import {
  isPinPublished,
  isPublishedRelease,
  listFollowFiles,
  resolveTagCommit,
} from "../scripts/follow-github.ts";
import { parseFollowManifest } from "../scripts/follow-pins.ts";
import { GithubHttpError } from "../scripts/github-api.ts";
import { requiredUvVersion, uvLockPath } from "../scripts/lock-follow.ts";
import { verifyFollowPins } from "../scripts/validate-release-build-request.ts";

const upstream = "fongap-labs/shared-lib";
const commit = "0123456789abcdef0123456789abcdef01234567";
const newCommit = "fedcba9876543210fedcba9876543210fedcba98";
const tagObject = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const release: FollowRelease = {
  repository: upstream,
  release_key: "shared-lib",
  version: "1.4.0",
  tag: "shared-lib-v1.4.0",
  commit: newCommit,
};

// A reader that serves the given paths and answers 404 for anything else, as the API does.
function serve(routes: Record<string, unknown>) {
  return {
    async get(path: string): Promise<unknown> {
      const key = path;
      if (Object.hasOwn(routes, key)) return routes[key];
      throw new GithubHttpError(404);
    },
  };
}

function contentOf(text: string) {
  return { encoding: "base64", content: Buffer.from(text, "utf8").toString("base64") };
}

// --- planning -----------------------------------------------------------------------------------

test("a follower's pins move to the release, one file per change, and up-to-date pins produce none", () => {
  const manifest = parseFollowManifest({
    upstream: { repository: upstream, release_key: "shared-lib" },
    pins: [
      { path: "lock.json", key: "/shared/commit", value: "commit" },
      { path: "requirements.toml", key: "shared.version", value: "version" },
    ],
  });
  const texts = new Map([
    ["lock.json", `{"shared":{"commit":"${commit}"}}`],
    ["requirements.toml", '[shared]\nversion = "1.3.0"\n'],
  ]);
  const changes = planFollowChanges(manifest, texts, release);
  assert.deepEqual(changes, [
    { path: "lock.json", text: `{"shared":{"commit":"${newCommit}"}}` },
    { path: "requirements.toml", text: '[shared]\nversion = "1.4.0"\n' },
  ]);

  // Already pinned: no change at all.
  const upToDate = new Map([
    ["lock.json", `{"shared":{"commit":"${newCommit}"}}`],
    ["requirements.toml", '[shared]\nversion = "1.4.0"\n'],
  ]);
  assert.deepEqual(planFollowChanges(manifest, upToDate, release), []);
});

test("a pin file missing at the branch head is refused", () => {
  const manifest = parseFollowManifest({
    upstream: { repository: upstream, release_key: "shared-lib" },
    pins: [{ path: "requirements.toml", key: "shared.version", value: "version" }],
  });
  assert.throws(
    () => planFollowChanges(manifest, new Map(), release),
    /missing at the branch head/
  );
});

test("branch names and project directories follow the product layout", () => {
  assert.equal(followBranchName("fongap-labs/web-app", ""), "aw/follow/web-app");
  assert.equal(followBranchName("fongap-labs/example", "api"), "aw/follow/api");
  assert.equal(followProjectDirectory(""), "");
  assert.equal(followProjectDirectory("api"), "projects/api");
  assert.equal(pinValueFor("commit", release), newCommit);
  assert.equal(pinValueFor("version", release), "1.4.0");
});

// --- discovery ----------------------------------------------------------------------------------

test("follow declarations are listed from one tree of the default branch", async () => {
  const declaration = {
    upstream: { repository: upstream, release_key: "shared-lib" },
    pins: [{ path: "requirements.toml", key: "shared.version", value: "version" }],
  };
  const reader = serve({
    "repos/fongap-labs/example/git/trees/main-sha?recursive=1": {
      truncated: false,
      tree: [
        { path: ".github/follows.json", type: "blob" },
        { path: "projects/api/follows.json", type: "blob" },
        { path: "projects/api/README.md", type: "blob" },
        { path: "projects/api/nested/follows.json", type: "blob" },
      ],
    },
    "repos/fongap-labs/example/contents/.github/follows.json?ref=main-sha": contentOf(
      JSON.stringify(declaration)
    ),
    "repos/fongap-labs/example/contents/projects/api/follows.json?ref=main-sha": contentOf(
      JSON.stringify(declaration)
    ),
  });
  const files = await listFollowFiles(reader, "fongap-labs/example", "main-sha");
  assert.deepEqual(
    files.map((file) => [file.product, file.path]),
    [
      ["", ".github/follows.json"],
      ["api", "projects/api/follows.json"],
    ]
  );
});

test("a truncated tree is refused rather than read partially", async () => {
  const reader = serve({
    "repos/fongap-labs/example/git/trees/main-sha?recursive=1": { truncated: true, tree: [] },
  });
  await assert.rejects(
    listFollowFiles(reader, "fongap-labs/example", "main-sha"),
    /Repository tree is truncated/
  );
});

test("an invalid follow declaration is refused with the repository and path", async () => {
  const reader = serve({
    "repos/fongap-labs/example/git/trees/main-sha?recursive=1": {
      truncated: false,
      tree: [{ path: ".github/follows.json", type: "blob" }],
    },
    "repos/fongap-labs/example/contents/.github/follows.json?ref=main-sha":
      contentOf('{"upstream":{}}'),
  });
  await assert.rejects(
    listFollowFiles(reader, "fongap-labs/example", "main-sha"),
    /Follow manifest/
  );
});

// --- published releases -------------------------------------------------------------------------

test("a version pin is published when its tag resolves and the release is not a draft", async () => {
  const reader = serve({
    [`repos/${upstream}/git/ref/tags/shared-lib-v1.4.0`]: {
      object: { type: "commit", sha: newCommit },
    },
    [`repos/${upstream}/releases/tags/shared-lib-v1.4.0`]: { draft: false },
  });
  assert.equal(await isPinPublished(reader, upstream, "shared-lib", "version", "1.4.0"), true);
  assert.equal(await isPinPublished(reader, upstream, "shared-lib", "version", "9.9.9"), false);
});

test("a draft release does not publish its tag", async () => {
  const reader = serve({
    [`repos/${upstream}/releases/tags/shared-lib-v1.4.0`]: { draft: true },
  });
  assert.equal(await isPublishedRelease(reader, upstream, "shared-lib-v1.4.0"), false);
});

test("a commit pin is published when a published tag of the key resolves to it through an annotated tag", async () => {
  const reader = serve({
    [`repos/${upstream}/git/matching-refs/tags/shared-lib-v`]: [
      { ref: "refs/tags/shared-lib-v1.4.0", object: { type: "tag", sha: tagObject } },
      { ref: "refs/tags/other-v1.0.0", object: { type: "commit", sha: commit } },
    ],
    [`repos/${upstream}/git/tags/${tagObject}`]: { object: { type: "commit", sha: newCommit } },
    [`repos/${upstream}/git/ref/tags/shared-lib-v1.4.0`]: {
      object: { type: "tag", sha: tagObject },
    },
    [`repos/${upstream}/releases/tags/shared-lib-v1.4.0`]: { draft: false },
  });
  assert.equal(await isPinPublished(reader, upstream, "shared-lib", "commit", newCommit), true);
  assert.equal(await isPinPublished(reader, upstream, "shared-lib", "commit", commit), false);
});

test("a tag that resolves through a chain of tags is refused", async () => {
  const reader = serve({
    [`repos/${upstream}/git/ref/tags/shared-lib-v1.4.0`]: {
      object: { type: "tag", sha: tagObject },
    },
    [`repos/${upstream}/git/tags/${tagObject}`]: { object: { type: "tag", sha: commit } },
  });
  await assert.rejects(
    resolveTagCommit(reader, upstream, "shared-lib-v1.4.0"),
    /must point to a commit/
  );
});

// --- release validation -------------------------------------------------------------------------

test("a follower releases only when its pins hold published upstream values", async () => {
  const policy = { [upstream]: ["release-target"] };
  const followsText = JSON.stringify({
    upstream: { repository: upstream, release_key: "shared-lib" },
    pins: [{ path: "requirements.toml", key: "shared.version", value: "version" }],
  });
  const source = "fongap-labs/example";
  const sourceSha = "main-sha";
  const reader = serve({
    [`repos/${source}/contents/requirements.toml?ref=${sourceSha}`]: contentOf(
      '[shared]\nversion = "1.4.0"\n'
    ),
    [`repos/${upstream}/git/ref/tags/shared-lib-v1.4.0`]: {
      object: { type: "commit", sha: newCommit },
    },
    [`repos/${upstream}/releases/tags/shared-lib-v1.4.0`]: { draft: false },
  });
  await verifyFollowPins(reader, { repository: source, sha: sourceSha, followsText, policy });

  const unpublished = serve({
    [`repos/${source}/contents/requirements.toml?ref=${sourceSha}`]: contentOf(
      '[shared]\nversion = "1.5.0"\n'
    ),
  });
  await assert.rejects(
    verifyFollowPins(unpublished, { repository: source, sha: sourceSha, followsText, policy }),
    /is not a published version of fongap-labs\/shared-lib/
  );

  await assert.rejects(
    verifyFollowPins(reader, {
      repository: source,
      sha: sourceSha,
      followsText,
      policy: { "fongap-labs/other": ["pr"] },
    }),
    /not a managed release target/
  );
});

// --- uv and sandbox -----------------------------------------------------------------------------

test("the required uv version must be one exact version", () => {
  assert.equal(requiredUvVersion({ tool: { uv: { "required-version": "==0.9.1" } } }), "0.9.1");
  assert.equal(requiredUvVersion({ tool: { uv: { "required-version": "0.9.1" } } }), "0.9.1");
  assert.throws(
    () => requiredUvVersion({ tool: { uv: { "required-version": ">=0.9" } } }),
    /one exact version/
  );
  assert.throws(() => requiredUvVersion({}), /must declare \[tool\.uv\] required-version/);
});

test("the lock path is inside the project directory", () => {
  assert.equal(uvLockPath(""), "uv.lock");
  assert.equal(uvLockPath("projects/api"), "projects/api/uv.lock");
});

test("follow lock artifacts are read in the flat and the per-artifact layout", () => {
  assert.deepEqual(followLockFolders("follow-lock", ["follow-lock.json", "uv-lock.patch"]), [
    "follow-lock",
  ]);
  assert.deepEqual(followLockFolders("follow-lock", ["follow-lock-a", "follow-lock-b"]), [
    join("follow-lock", "follow-lock-a"),
    join("follow-lock", "follow-lock-b"),
  ]);
});

test("a patch without its final newline is still applied", () => {
  assert.equal(patchWithFinalNewline(""), "");
  assert.equal(
    patchWithFinalNewline("diff --git a/uv.lock b/uv.lock\n+line"),
    "diff --git a/uv.lock b/uv.lock\n+line\n"
  );
  assert.equal(
    patchWithFinalNewline("diff --git a/uv.lock b/uv.lock\n+line\n"),
    "diff --git a/uv.lock b/uv.lock\n+line\n"
  );
});

const lockPatch = [
  "diff --git a/projects/api/uv.lock b/projects/api/uv.lock",
  "index 1111111..2222222 100644",
  "--- a/projects/api/uv.lock",
  "+++ b/projects/api/uv.lock",
  "@@ -1,3 +1,3 @@",
  " version = 1",
  "--- old comment that starts with two dashes",
  "+++ new comment",
  "-version = 2",
  "+version = 3",
  "",
].join("\n");

test("a patch that changes only the project's uv.lock is accepted, even when a body line starts with dashes", () => {
  assert.doesNotThrow(() => validateLockPatch(lockPatch, "projects/api/uv.lock"));
  assert.doesNotThrow(() => validateLockPatch("", "projects/api/uv.lock"));
});

test("a patch that adds, deletes, renames or touches another file is refused", () => {
  const refused = [
    lockPatch.replace(/projects\/api\/uv\.lock/g, "other/uv.lock"),
    lockPatch.replace("index 1111111..2222222 100644", "new file mode 100644"),
    lockPatch.replace("index 1111111..2222222 100644", "deleted file mode 100644"),
    lockPatch.replace("index 1111111..2222222 100644", "rename from projects/api/uv.lock"),
    lockPatch + "diff --git a/projects/api/uv.lock b/projects/api/uv.lock\n",
    lockPatch.replace("@@ -1,3 +1,3 @@", "@@ -1,3 +1,3 @@\n-- not a dash line\n!bad"),
  ];
  for (const patch of refused) {
    assert.throws(() => validateLockPatch(patch, "projects/api/uv.lock"), Error);
  }
});

test("a follow lock request names a follow branch, a commit and a valid project directory", () => {
  const valid = {
    repository: "fongap-labs/example",
    branch: "aw/follow/api",
    head_sha: commit,
    project_dir: "projects/api",
  };
  assert.deepEqual(parseFollowLockRequest(valid), valid);
  assert.throws(() => parseFollowLockRequest({ ...valid, branch: "main" }), /invalid/);
  assert.throws(() => parseFollowLockRequest({ ...valid, project_dir: "../escape" }), /invalid/);
  assert.throws(() => parseFollowLockRequest({ ...valid, head_sha: "short" }), /invalid/);
});

// --- workflow -----------------------------------------------------------------------------------

test("the follow jobs run in the right order, and the sandbox job holds no control credential", async () => {
  const { readFile } = await import("node:fs/promises");
  const { parse } = await import("yaml");
  const workflow = parse(
    await readFile(".github/workflows/handle-release-dispatch.yml", "utf8")
  ) as {
    jobs: Record<
      string,
      {
        needs?: unknown;
        if?: string;
        permissions?: unknown;
        outputs?: Record<string, string>;
        steps?: Array<{ env?: unknown; run?: string }>;
      }
    >;
  };
  const jobs = workflow.jobs;
  assert.deepEqual(
    Object.keys(jobs).sort(),
    ["follow", "follow-commit", "follow-lock", "release"].sort()
  );
  assert.equal(jobs.follow?.needs, "release");
  assert.deepEqual(jobs["follow-lock"]?.needs, "follow");
  assert.deepEqual(jobs["follow-commit"]?.needs, ["follow", "follow-lock"]);

  // The release job hands the follow jobs the values they check against the upstream.
  assert.deepEqual(Object.keys(jobs.release?.outputs ?? {}).sort(), [
    "release_key",
    "tag",
    "target_repository",
    "version",
  ]);

  // The sandbox job never sees a central credential.
  const sandbox = JSON.stringify(jobs["follow-lock"]);
  assert.equal(sandbox.includes("AW_CONTROL_TOKEN"), false);
  assert.equal(sandbox.includes("AW_REPOSITORY_POLICY"), false);
  assert.equal(
    sandbox.includes("secrets.AW_CHECKOUT_TOKEN"),
    true,
    "a private follower needs the read token"
  );

  // Only the control-domain steps see the control token.
  for (const name of ["follow", "follow-commit"]) {
    assert.equal(JSON.stringify(jobs[name]).includes("AW_CONTROL_TOKEN"), true, name);
  }
});
