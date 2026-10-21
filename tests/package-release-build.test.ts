import assert from "node:assert/strict";
import { test } from "node:test";
import { buildReleaseManifest } from "../scripts/package-release-build.ts";
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

test("computed notes only fill an empty manifest value, and the manifest stays the authority", () => {
  const silent = parseReleaseBuildManifest({ ...build, release_notes: "" });
  const assets = [{ name: "delta-windows-x64-portable.zip", sha256: "a".repeat(64) }];

  const filled = buildReleaseManifest(silent, "0.1.0", assets, "- fix: stop the retry storm");
  assert.equal(filled.release_notes, "- fix: stop the retry storm");

  const curated = buildReleaseManifest(build, "0.1.0", assets, "- fix: stop the retry storm");
  assert.equal(curated.release_notes, "Delta Windows portable release.");

  const quiet = buildReleaseManifest(silent, "0.1.0", assets, "");
  assert.equal(quiet.release_notes, "");
});

test("packaged release notes refuse to exceed the manifest limit", () => {
  const silent = parseReleaseBuildManifest({
    ...build,
    release_notes: "",
  });
  assert.throws(
    () => buildReleaseManifest(silent, "0.1.0", [], "- fix: x".repeat(4000)),
    /manifest limit/
  );
});
