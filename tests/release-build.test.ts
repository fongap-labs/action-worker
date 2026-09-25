import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseCargoPackageVersion,
  parseCargoWorkspaceVersion,
  parseReleaseBuildManifest,
  parseReleaseBuildRequest,
} from "../scripts/validate-release-build-request.ts";

const manifest = {
  schema_version: 1,
  artifact_name: "delta-release",
  target_repository: "fongap-labs/external-vault",
  release_key: "delta",
  release_name: "Delta",
  release_notes: "Delta Windows portable release.",
  license_expression: "Apache-2.0",
  node_version_file: ".nvmrc",
  python_version_file: ".python-version",
  sbom_asset: "delta-windows-x64-portable.sbom.cdx.json",
  version_source: {
    type: "cargo-package",
    path: "apps/desktop/src-tauri/Cargo.toml",
  },
  builds: [{
    id: "windows-portable",
    runner_profile: "windows-build",
    target: "x86_64-pc-windows-msvc",
    script: ".github/scripts/release-build.ps1",
    assets: ["delta-windows-x64-portable.zip"],
    attest_asset: "delta-windows-x64-portable.zip",
  }],
};

test("release build manifest is exact and project scoped", () => {
  assert.deepEqual(parseReleaseBuildManifest(manifest), manifest);
  assert.throws(() => parseReleaseBuildManifest({
    ...manifest,
    unknown: true,
  }));
});

test("release build manifest binds attestation and package assets", () => {
  assert.throws(() => parseReleaseBuildManifest({
    ...manifest,
    builds: [{
      ...manifest.builds[0],
      attest_asset: "not-produced.zip",
    }],
  }));
  assert.throws(() => parseReleaseBuildManifest({
    ...manifest,
    sbom_asset: "delta-windows-x64-portable.zip",
  }));
});

test("release build manifest uses abstract runner profiles", () => {
  assert.equal(parseReleaseBuildManifest(manifest).builds[0]?.runner_profile, "windows-build");
  assert.throws(() => parseReleaseBuildManifest({
    ...manifest,
    builds: [{
      ...manifest.builds[0],
      runner_profile: undefined,
      runner: "windows-latest",
    }],
  }));
});

test("release build request is immutable-source only", () => {
  const request = {
    schema_version: "1",
    request_id: "release-build-1",
    source_repository: "fongap-labs/app-source",
    source_sha: "a".repeat(40),
    requested_version: "v0.1.0",
  };
  assert.deepEqual(parseReleaseBuildRequest(request), request);
  assert.throws(() => parseReleaseBuildRequest({ ...request, source_sha: "main" }));
});

test("cargo version parsers require stable SemVer", () => {
  assert.equal(
    parseCargoWorkspaceVersion('[workspace]\n\n[workspace.package]\nversion = "0.1.0"\nedition = "2021"\n'),
    "0.1.0",
  );
  assert.equal(
    parseCargoPackageVersion('[package]\nname = "delta-desktop"\nversion = "0.1.0"\n'),
    "0.1.0",
  );
  assert.throws(() => parseCargoWorkspaceVersion('[workspace.package]\nversion = "0.1.0-dev.1"\n'));
  assert.throws(() => parseCargoPackageVersion('[package]\nversion = "0.1.0-rc.1"\n'));
});
