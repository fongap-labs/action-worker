import assert from "node:assert/strict";
import { test } from "node:test";
import {
  npmPackageIntegrity,
  parseNpmChecksum,
  validateNpmPackageManifest,
  validateNpmRelease,
  validateNpmRepublishRequest,
} from "../scripts/republish-release-npm.ts";

const repository = "fongap-labs/dsh-plugin";
const controlRepository = "fongap-labs/action-worker";
const tag = "dsh-ui-delta-v0.1.0-beta.2";
const policy = { [repository]: ["release-source", "release-target"] };

function release(
  body = [
    "Source: https://github.com/fongap-labs/dsh-plugin/commit/11bb7f999a7cf0048d1e647b9f1d1be2fbee05d1",
    "Artifact run: https://github.com/fongap-labs/action-worker/actions/runs/41385432571",
    "Central CI Evidence: success",
    "Main Write Guard: success via PR #22",
  ].join("\n")
) {
  return {
    draft: false,
    tag_name: tag,
    prerelease: true,
    target_commitish: "1bab6b6114c9ed0dc923f584bfa8ea402972087f",
    html_url: `https://github.com/fongap-labs/dsh-plugin/releases/tag/${tag}`,
    body,
    assets: [
      {
        name: "fongap-labs-dsh-ui-delta.tgz",
        state: "uploaded",
        digest: `sha256:${"a".repeat(64)}`,
      },
      { name: "fongap-labs-dsh-ui-delta.tgz.sha256", state: "uploaded" },
      { name: "dsh-ui-delta-sbom.cdx.json", state: "uploaded" },
    ],
  };
}

test("npm republish accepts only a release-target repository", () => {
  assert.doesNotThrow(() =>
    validateNpmRepublishRequest(repository, tag, controlRepository, policy)
  );
  assert.throws(() =>
    validateNpmRepublishRequest("fongap-labs/unlisted", tag, controlRepository, policy)
  );
});

test("npm republish requires a published, provenance-verified release and paired checksum", () => {
  assert.deepEqual(validateNpmRelease(repository, tag, controlRepository, release(), policy), {
    tarballName: "fongap-labs-dsh-ui-delta.tgz",
    checksumName: "fongap-labs-dsh-ui-delta.tgz.sha256",
    version: "0.1.0-beta.2",
    digest: "a".repeat(64),
  });
  assert.throws(() =>
    validateNpmRelease(repository, tag, controlRepository, release("manual release"), policy)
  );
});

test("npm package metadata must be public, scoped, and match the release tag", () => {
  assert.deepEqual(
    validateNpmPackageManifest(
      { name: "@fongap-labs/dsh-ui-delta", version: "0.1.0-beta.2", private: false },
      "0.1.0-beta.2"
    ),
    { name: "@fongap-labs/dsh-ui-delta", version: "0.1.0-beta.2" }
  );
  assert.throws(() =>
    validateNpmPackageManifest({ name: "@other/package", version: "0.1.0-beta.2" }, "0.1.0-beta.2")
  );
  assert.throws(() =>
    validateNpmPackageManifest(
      { name: "@fongap-labs/dsh-ui-delta", version: "0.1.0" },
      "0.1.0-beta.2"
    )
  );
});

test("npm release checksums and integrity use the downloaded tarball bytes", () => {
  assert.equal(parseNpmChecksum(`${"a".repeat(64)}  package.tgz\n`, "package.tgz"), "a".repeat(64));
  assert.throws(() => parseNpmChecksum(`${"a".repeat(64)}  other.tgz`, "package.tgz"));
  assert.match(npmPackageIntegrity(Buffer.from("npm tarball")), /^sha512-/);
});
