import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parse } from "yaml";
import { publishNpmBeforeTag, selectPreTagNpmAsset } from "../scripts/release-npm-gate.ts";

const plugin = "fongap-labs/dsh-plugin";
const asset = { name: "fongap-labs-dsh-delta-code.tgz", sha256: "a".repeat(64) };

test("stable DSH plugin releases require the exact npm package", () => {
  assert.deepEqual(
    selectPreTagNpmAsset(plugin, plugin, "dsh-delta-code", "0.1.0", false, [asset]),
    asset
  );
  assert.equal(
    selectPreTagNpmAsset(
      "fongap-labs/external-vault",
      "fongap-labs/external-vault",
      "steno",
      "0.1.0",
      false,
      []
    ),
    null
  );
  assert.throws(
    () => selectPreTagNpmAsset(plugin, plugin, "dsh-delta-code", "0.1.0", false, []),
    /exactly its named npm tarball/
  );
  assert.throws(
    () =>
      selectPreTagNpmAsset(plugin, plugin, "dsh-delta-code", "0.1.0", false, [asset, { ...asset }]),
    /exactly its named npm tarball/
  );
  assert.throws(
    () => selectPreTagNpmAsset(plugin, plugin, "dsh-delta-desktop", "0.1.0", false, [asset]),
    /exactly its named npm tarball/
  );
  assert.throws(
    () =>
      selectPreTagNpmAsset("fongap-labs/external-vault", plugin, "dsh-delta-code", "0.1.0", false, [
        asset,
      ]),
    /source must be/
  );
});

test("Beta never publishes npm, even when the prerelease flag is misconfigured", async () => {
  assert.equal(
    selectPreTagNpmAsset(plugin, plugin, "dsh-delta-code", "0.1.0-beta.2", true, [asset]),
    null
  );
  assert.equal(
    selectPreTagNpmAsset(plugin, plugin, "dsh-delta-code", "0.1.0-beta.2", false, [asset]),
    null
  );
  const targetResolver = await readFile("scripts/resolve-release-target.ts", "utf8");
  assert.match(targetResolver, /npm_required=/);
  assert.match(targetResolver, /isStableNpmRelease\(/);
  assert.equal(
    selectPreTagNpmAsset(plugin, plugin, "dsh-delta-code", "0.1.0", true, [asset]),
    null
  );
  assert.equal(
    selectPreTagNpmAsset(plugin, plugin, "dsh-delta-code", "0.1.0-beta.2", true, []),
    null
  );
  await assert.rejects(
    publishNpmBeforeTag({
      tarballPath: "unused.tgz",
      workDir: "/tmp",
      releaseKey: "dsh-delta-code",
      version: "0.1.0-beta.2",
      token: "unused",
    }),
    /must not publish npm/
  );
});

test("a formal release tag is gated on npm registry confirmation, not an async dispatch", async () => {
  const workflowText = await readFile(".github/workflows/handle-release-dispatch.yml", "utf8");
  const workflow = parse(workflowText) as {
    jobs: {
      release: {
        steps: Array<{ name?: string; env?: Record<string, string> }>;
      };
      npm?: unknown;
    };
  };
  assert.equal(workflow.jobs.npm, undefined);
  const publish = workflow.jobs.release.steps.find(
    (step) => step.name === "Publish governed release"
  );
  assert.equal(
    publish?.env?.AW_NPM_TOKEN,
    "${{ steps.release_target.outputs.npm_required == 'true' && secrets.AW_NPM_TOKEN || '' }}"
  );
  const source = await readFile("scripts/publish-release.ts", "utf8");
  const checksumVerified = source.indexOf("Published Release checksum verification failed");
  const npmGate = source.indexOf("await publishNpmBeforeTag({");
  const releasePublish = source.indexOf("isPublishAttempted = true;");
  assert.ok(checksumVerified !== -1 && npmGate > checksumVerified);
  assert.ok(releasePublish > npmGate);
  assert.doesNotMatch(workflowText, /run-npm-republish/);
});

test("npm registry read-back and dist-tag checks must both pass before tagging", async () => {
  const source = await readFile("scripts/release-npm-gate.ts", "utf8");
  assert.ok(source.indexOf("await waitForPublishedIntegrity(") > 0);
  assert.ok(
    source.indexOf("await ensureDistTag(") > source.indexOf("await waitForPublishedIntegrity(")
  );
  assert.ok(source.includes("npm dist-tag was not confirmed; GitHub Release tag withheld"));
  assert.ok(source.includes("npm package name does not match the governed release key"));
});
