import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  assertMatchingPublishedRelease,
  type PublishedReleaseReplay,
} from "../scripts/release-published-replay.ts";

const sha = "a".repeat(40);
const digest = "b".repeat(64);
const request: PublishedReleaseReplay = {
  repository: "fongap-labs/dsh-plugin",
  tag: "dsh-delta-suite-v0.1.0-beta.1",
  sourceRepository: "fongap-labs/dsh-plugin",
  sourceSha: "c".repeat(40),
  artifactRepository: "fongap-labs/action-worker",
  artifactRunId: 123,
  requestId: "release-build-123-1",
  isPrerelease: true,
  assets: [{ name: "dsh-delta-suite.zip", sha256: digest }],
};

function fixture() {
  const checksum = createHash("sha256").update(`${digest}  dsh-delta-suite.zip\n`).digest("hex");
  const tagRef = { ref: `refs/tags/${request.tag}`, object: { type: "commit", sha } };
  const release = {
    tag_name: request.tag,
    target_commitish: sha,
    draft: false,
    prerelease: true,
    published_at: "2026-11-20T00:00:00Z",
    html_url: `https://github.com/${request.repository}/releases/tag/${request.tag}`,
    body: [
      `Source: https://github.com/${request.sourceRepository}/commit/${request.sourceSha}`,
      `Artifact run: https://github.com/${request.artifactRepository}/actions/runs/${request.artifactRunId}`,
      "Central CI Evidence: success",
      "Main Write Guard: success via PR #431",
      `Request: ${request.requestId}`,
    ].join("\n"),
    assets: [
      { name: "dsh-delta-suite.zip", state: "uploaded", digest: `sha256:${digest}` },
      { name: "dsh-delta-suite.zip.sha256", state: "uploaded", digest: `sha256:${checksum}` },
    ],
  };
  return { tagRef, release };
}

test("identical published release is a read-only replay after full upstream checks", () => {
  const { tagRef, release } = fixture();
  assert.doesNotThrow(() => assertMatchingPublishedRelease(tagRef, release, request));
});

test("bare tag, missing tag, and draft never receive a false-green replay", () => {
  const { tagRef, release } = fixture();
  assert.throws(() => assertMatchingPublishedRelease(tagRef, undefined, request), /conflicts/);
  assert.throws(() => assertMatchingPublishedRelease(undefined, release, request), /conflicts/);
  assert.throws(
    () => assertMatchingPublishedRelease(tagRef, { ...release, draft: true }, request),
    /conflicts/
  );
});

test("a same-name tag at another commit and forged release metadata fail closed", () => {
  const { tagRef, release } = fixture();
  assert.throws(
    () =>
      assertMatchingPublishedRelease(
        { ...tagRef, object: { type: "commit", sha: "d".repeat(40) } },
        release,
        request
      ),
    /conflicts/
  );
  assert.throws(
    () => assertMatchingPublishedRelease(tagRef, { ...release, tag_name: "another-tag" }, request),
    /conflicts/
  );
  assert.throws(
    () => assertMatchingPublishedRelease(tagRef, { ...release, prerelease: false }, request),
    /conflicts/
  );
});

test("different source, artifact, request or missing signed gates cannot replay", () => {
  const { tagRef, release } = fixture();
  for (const body of [
    release.body.replace(request.sourceSha, "d".repeat(40)),
    release.body.replace("actions/runs/123", "actions/runs/124"),
    release.body.replace(request.requestId, "release-build-999-1"),
    release.body.replace("Central CI Evidence: success", "Central CI Evidence: failure"),
    release.body.replace("Main Write Guard: success via PR #431", "Main Write Guard: unknown"),
  ]) {
    assert.throws(
      () => assertMatchingPublishedRelease(tagRef, { ...release, body }, request),
      /conflicts/
    );
  }
});

test("missing, duplicate, extra, or mismatched asset digests cannot replay", () => {
  const { tagRef, release } = fixture();
  for (const assets of [
    release.assets.slice(0, 1),
    [...release.assets, release.assets[0]],
    [...release.assets, { name: "extra", state: "uploaded", digest: `sha256:${digest}` }],
    release.assets.map((a, i) => (i === 0 ? { ...a, digest: `sha256:${"d".repeat(64)}` } : a)),
    release.assets.map((a, i) => (i === 1 ? { ...a, digest: null } : a)),
  ]) {
    assert.throws(
      () => assertMatchingPublishedRelease(tagRef, { ...release, assets }, request),
      /conflicts/
    );
  }
});

test("release dispatch serializes each product across repeated artifact runs", async () => {
  const workflow = await readFile(".github/workflows/handle-release-dispatch.yml", "utf8");
  assert.match(
    workflow,
    /group: release-\$\{\{ github\.event\.client_payload\.source_repository \}\}-\$\{\{ github\.event\.client_payload\.artifact_name \}\}/
  );
  assert.doesNotMatch(workflow, /group: release-[^\n]*artifact_run_id/);
  assert.match(workflow, /cancel-in-progress: false/);
});

test("dev replay requires its own proof and exact source tag", () => {
  const { tagRef, release } = fixture();
  const beta: PublishedReleaseReplay = { ...request, sourceBranch: "dev" };
  const ref = { ...tagRef, object: { type: "commit", sha: request.sourceSha } };
  const published = {
    ...release,
    target_commitish: request.sourceSha,
    body: release.body
      .replace("Central CI Evidence", "Dev CI Evidence")
      .replace("Main Write Guard", "Dev Write Guard"),
  };
  assert.doesNotThrow(() => assertMatchingPublishedRelease(ref, published, beta));
  assert.throws(() =>
    assertMatchingPublishedRelease(ref, { ...published, body: release.body }, beta)
  );
  assert.throws(() => assertMatchingPublishedRelease(tagRef, release, beta));
});
