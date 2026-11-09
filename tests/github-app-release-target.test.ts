import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parse } from "yaml";
import { scopedReleaseRepositories } from "../scripts/resolve-release-repositories.ts";
import { releaseTargetFromArtifact } from "../scripts/resolve-release-target.ts";

const sha = "a".repeat(40);
const assetHash = "b".repeat(64);
const request = {
  schema_version: "2",
  request_id: "release-request-1",
  source_repository: "fongap-labs/source",
  source_sha: sha,
  artifact_repository: "fongap-labs/action-worker",
  artifact_run_id: 123,
  artifact_name: "release",
};
const manifest = {
  schema_version: "1",
  target_repository: "fongap-labs/target",
  release_key: "example",
  version: "1.2.3",
  assets: [{ name: "example.zip", sha256: assetHash }],
};
const provenance = {
  schema_version: "1",
  source_repository: request.source_repository,
  source_sha: request.source_sha,
  artifact_repository: request.artifact_repository,
  artifact_run_id: request.artifact_run_id,
};
const policy = {
  "fongap-labs/source": ["release-source"],
  "fongap-labs/target": ["release-target"],
  "fongap-labs/another": ["release-source", "release-target"],
};

test("release read token scope includes only managed sources, targets and control", () => {
  assert.deepEqual(scopedReleaseRepositories(policy, "fongap-labs/action-worker"), [
    "action-worker",
    "another",
    "source",
    "target",
  ]);
  assert.throws(
    () =>
      scopedReleaseRepositories(
        { ...policy, "other-owner/foreign": ["release-target"] },
        "fongap-labs/action-worker"
      ),
    /Cross-owner access/
  );
});

test("release publication target is resolved only from a validated artifact and policy", () => {
  assert.deepEqual(
    releaseTargetFromArtifact(request, manifest, provenance, policy, "fongap-labs/action-worker"),
    {
      owner: "fongap-labs",
      repository_name: "target",
      target_repository: "fongap-labs/target",
    }
  );
  assert.throws(
    () =>
      releaseTargetFromArtifact(
        request,
        { ...manifest, target_repository: "fongap-labs/unmanaged" },
        provenance,
        policy,
        "fongap-labs/action-worker"
      ),
    /not allowed for release-target/
  );
  assert.throws(
    () =>
      releaseTargetFromArtifact(
        request,
        manifest,
        { ...provenance, source_sha: "c".repeat(40) },
        policy,
        "fongap-labs/action-worker"
      ),
    /provenance does not match/
  );
});

test("release publication is scoped to the artifact target and uses no broad PAT", async () => {
  const source = await readFile(".github/workflows/handle-release-dispatch.yml", "utf8");
  const workflow = parse(source) as {
    jobs: {
      release: {
        steps: Array<{
          name?: string;
          id?: string;
          with?: Record<string, string>;
          env?: Record<string, string>;
        }>;
      };
    };
  };
  const steps = workflow.jobs.release.steps;
  const find = (name: string) => {
    const step = steps.find((entry) => entry.name === name);
    assert.ok(step, name);
    return step;
  };
  const read = find("Mint governed release read token");
  assert.equal(read.with?.["permission-contents"], "read");
  assert.equal(read.with?.["permission-actions"], "read");
  const download = find("Download proposed release artifact");
  assert.equal(download.with?.["github-token"], "${{ steps.release_read_app.outputs.token }}");
  assert.equal(find("Resolve verified release target scope").id, "release_target");
  const write = find("Mint target-only release publication token");
  assert.equal(write.with?.repositories, "${{ steps.release_target.outputs.repository_name }}");
  assert.deepEqual(
    Object.entries(write.with ?? {}).filter(([key]) => key.startsWith("permission-")),
    [["permission-contents", "write"]]
  );
  const publish = find("Publish governed release");
  assert.equal(publish.env?.AW_CONTROL_TOKEN, "${{ steps.release_read_app.outputs.token }}");
  assert.equal(
    publish.env?.AW_RELEASE_WRITE_API_TOKEN,
    "${{ steps.release_write_app.outputs.token }}"
  );
  assert.equal(
    publish.env?.AW_RELEASE_TARGET_REPOSITORY,
    "${{ steps.release_target.outputs.target_repository }}"
  );
  assert.doesNotMatch(source, /secrets\.AW_CONTROL_TOKEN/);
});

test("release script refuses missing App writer and enforces artifact target match", async () => {
  const source = await readFile("scripts/publish-release.ts", "utf8");
  assert.match(source, /AW_RELEASE_WRITE_API_TOKEN/);
  assert.match(source, /AW_RELEASE_TARGET_REPOSITORY/);
  assert.match(source, /targetRepository !== approvedTarget/);
  assert.match(source, /no PAT fallback/);
  assert.match(
    source,
    /rollbackRelease\(\s*targetRepository,\s*tag,\s*releaseId,\s*isReleaseCreated,\s*isPublishAttempted,\s*releaseWriteToken\s*\)/
  );
});
