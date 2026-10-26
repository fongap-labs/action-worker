import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checksumForAsset,
  isVerifiedCommit,
  parseToolMetadata,
  parseUrlToolMetadata,
  selectStableRelease,
  toolKeyArgument,
} from "../scripts/sync-tool-release.ts";

const pinnedUrlMetadata = {
  schema_version: "1",
  release_key: "r-base",
  platform: "source",
  arch: "any",
  upstream_url: "https://cran.r-project.org/src/base/R-4/R-4.6.0.tar.xz",
  upstream_version: "4.6.0",
  upstream_asset: "R-4.6.0.tar.xz",
  upstream_sha256: "b".repeat(64),
  license_expression: "GPL-2.0-or-later",
};

test("url tool metadata pins a version and a SHA-256 for an HTTPS file", () => {
  assert.deepEqual(parseUrlToolMetadata(pinnedUrlMetadata), pinnedUrlMetadata);
});

test("url tool metadata refuses an unpinned, plain-HTTP or mismatched source", () => {
  const refused = (change: Record<string, unknown>) =>
    assert.throws(() => parseUrlToolMetadata({ ...pinnedUrlMetadata, ...change }));
  refused({ upstream_url: "http://cran.r-project.org/src/base/R-4/R-4.6.0.tar.xz" });
  refused({ upstream_url: "https://user:pass@cran.r-project.org/R-4/R-4.6.0.tar.xz" });
  refused({ upstream_url: "https://cran.r-project.org/src/base/R-4/R-4.6.1.tar.xz" });
  refused({ upstream_sha256: "__PIN_R_SOURCE_SHA256_HERE__" });
  refused({ upstream_sha256: "0".repeat(64) });
  refused({ upstream_sha256: "B".repeat(64) });
  refused({ upstream_version: "4.6" });
  refused({ release_channel: "stable" });
});

test("url tool metadata accepts a three- or four-part numeric version", () => {
  const fourPart = {
    ...pinnedUrlMetadata,
    release_key: "algdesign",
    upstream_url: "https://cran.r-project.org/src/contrib/AlgDesign_1.2.1.2.tar.gz",
    upstream_version: "1.2.1.2",
    upstream_asset: "AlgDesign_1.2.1.2.tar.gz",
  };
  assert.deepEqual(parseUrlToolMetadata(fourPart), fourPart);
  const refused = (version: string) =>
    assert.throws(() => parseUrlToolMetadata({ ...pinnedUrlMetadata, upstream_version: version }));
  refused("1.2-5");
  refused("2.7");
  refused("1.2.1.2.3");
});

test("url tool metadata rejects unknown keys", () => {
  assert.throws(() => parseUrlToolMetadata({ ...pinnedUrlMetadata, extra: true }));
});

test("tool metadata is explicit and stable-channel only", () => {
  const metadata = {
    schema_version: "1",
    release_key: "open-code-review",
    source_repository: "alibaba/open-code-review",
    release_channel: "stable",
    platform: "linux",
    arch: "amd64",
    upstream_asset: "opencodereview-linux-amd64",
    checksum_asset: "sha256sum.txt",
    license_path: "LICENSE",
    license_expression: "Apache-2.0",
  };
  assert.deepEqual(parseToolMetadata(metadata), metadata);
  assert.throws(() => parseToolMetadata({ ...metadata, release_channel: "nightly" }));
  assert.throws(() => parseToolMetadata({ ...metadata, unknown: true }));
});

test("stable tool release selection ignores drafts and prereleases", () => {
  assert.equal(
    selectStableRelease([
      { tag_name: "v2.0.0", draft: true, prerelease: false },
      { tag_name: "v1.3.0-rc.1", draft: false, prerelease: true },
      { tag_name: "v1.2.3", draft: false, prerelease: false },
    ]).tag_name,
    "v1.2.3"
  );
});

test("upstream checksum parsing binds the requested asset", () => {
  const hash = "a".repeat(64);
  assert.equal(
    checksumForAsset(`${hash}  opencodereview-linux-amd64\n`, "opencodereview-linux-amd64"),
    hash
  );
  assert.throws(() => checksumForAsset(`${hash}  other-asset\n`, "opencodereview-linux-amd64"));
});

test("the tool sync takes its tool key explicitly and never defaults", () => {
  assert.equal(toolKeyArgument("r-base"), "r-base");
  assert.equal(toolKeyArgument("open-code-review"), "open-code-review");
  assert.throws(() => toolKeyArgument(undefined), /Usage/);
  assert.throws(() => toolKeyArgument(""), /Usage/);
  assert.throws(() => toolKeyArgument("R Base"), /Usage/);
  assert.throws(() => toolKeyArgument("../r-base"), /Usage/);
});

test("a release is only published from a verified commit", () => {
  assert.equal(
    isVerifiedCommit({ sha: "a".repeat(40), commit: { verification: { verified: true } } }),
    true
  );
  assert.equal(
    isVerifiedCommit({ commit: { verification: { verified: false, reason: "unsigned" } } }),
    false
  );
  assert.equal(isVerifiedCommit({ commit: {} }), false);
  assert.equal(isVerifiedCommit({}), false);
});
