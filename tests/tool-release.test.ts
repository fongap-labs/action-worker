import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checksumForAsset,
  parseToolMetadata,
  selectStableRelease,
} from "../scripts/sync-tool-release.ts";

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
    "v1.2.3",
  );
});

test("upstream checksum parsing binds the requested asset", () => {
  const hash = "a".repeat(64);
  assert.equal(
    checksumForAsset(`${hash}  opencodereview-linux-amd64\n`, "opencodereview-linux-amd64"),
    hash,
  );
  assert.throws(() => checksumForAsset(`${hash}  other-asset\n`, "opencodereview-linux-amd64"));
});
