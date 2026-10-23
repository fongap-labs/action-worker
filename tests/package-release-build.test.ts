import assert from "node:assert/strict";
import { test } from "node:test";
import { buildReleaseManifest, parsePackageArguments } from "../scripts/package-release-build.ts";
import { buildReleaseTitle } from "../scripts/publish-release.ts";
import { parseReleaseBuildManifest } from "../scripts/validate-release-build-request.ts";

const build = parseReleaseBuildManifest({
  schema_version: 1,
  artifact_name: "delta-release",
  target_repository: "fongap-labs/delta",
  release_key: "delta",
  release_name: "Delta",
  release_notes: "Delta Windows portable release.",
  license_expression: "Apache-2.0",
  node_version_file: ".nvmrc",
  python_version_file: ".python-version",
  sbom_asset: "delta-windows-x64-portable.sbom.cdx.json",
  builds: [
    {
      id: "windows-portable",
      runner_profile: "windows-build",
      target: "x86_64-pc-windows-msvc",
      script: ".github/scripts/release-build.ps1",
      assets: ["delta-windows-x64-portable.zip"],
      attest_asset: "delta-windows-x64-portable.zip",
    },
  ],
});

test("packaged release keeps the display name so the title carries the version once", () => {
  const release = buildReleaseManifest(build, "0.1.0", [
    { name: "delta-windows-x64-portable.zip", sha256: "a".repeat(64) },
  ]);
  assert.equal(release.release_name, "Delta");
  assert.equal(release.version, "0.1.0");
  assert.equal(buildReleaseTitle(release.release_name, release.version), "Delta v0.1.0");
});

test("the manifest's release notes are kept as written; an empty value is left for publication", () => {
  const silent = parseReleaseBuildManifest({ ...build, release_notes: "" });
  const assets = [{ name: "delta-windows-x64-portable.zip", sha256: "a".repeat(64) }];

  const curated = buildReleaseManifest(build, "0.1.0", assets);
  assert.equal(curated.release_notes, "Delta Windows portable release.");

  const empty = buildReleaseManifest(silent, "0.1.0", assets);
  assert.equal(empty.release_notes, "");
});

test("the packaging arguments accept a formal version and a beta, and reject other versions", () => {
  const sha = "a".repeat(40);
  const args = (version: string) => [
    ".github/release.manifest.json",
    "fongap-labs/delta",
    sha,
    version,
    "release-package",
  ];
  assert.equal(parsePackageArguments(args("1.2.3")).version, "1.2.3");
  assert.equal(parsePackageArguments(args("0.1.1-beta.1")).version, "0.1.1-beta.1");
  for (const version of ["", "v1.2.3", "1.2", "1.2.3-beta.0", "1.2.3-rc.1", "1.2.3+build"]) {
    assert.throws(() => parsePackageArguments(args(version)), /Usage: package-release-build/);
  }
  assert.throws(
    () => parsePackageArguments(args("1.2.3").slice(0, 4)),
    /Usage: package-release-build/
  );
});

test("a beta is packaged as a pre-release and a formal version is not", () => {
  const assets = [{ name: "delta-windows-x64-portable.zip", sha256: "a".repeat(64) }];
  assert.equal(buildReleaseManifest(build, "0.1.1-beta.1", assets).prerelease, true);
  assert.equal(buildReleaseManifest(build, "0.1.1", assets).prerelease, false);
});
