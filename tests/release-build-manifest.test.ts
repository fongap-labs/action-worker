import assert from "node:assert/strict";
import { test } from "node:test";
import { parseReleaseBuildManifest } from "../scripts/validate-release-build-request.ts";

const manifest = {
  schema_version: 1,
  artifact_name: "example-release",
  target_repository: "fongap-labs/external-vault",
  release_key: "example",
  release_name: "Example",
  release_notes: "Example release.",
  license_expression: "Apache-2.0",
  node_version_file: ".nvmrc",
  python_version_file: "",
  sbom_asset: "example.sbom.cdx.json",
  version_source: {
    type: "cargo-package",
    path: "Cargo.toml",
  },
  builds: [{
    id: "windows",
    runner_profile: "windows-build",
    target: "x86_64-pc-windows-msvc",
    script: ".github/scripts/release-build.ps1",
    assets: ["example.zip"],
    attest_asset: "example.zip",
  }],
};

test("release build manifest keeps project metadata in the source repository", () => {
  const parsed = parseReleaseBuildManifest(manifest);
  assert.equal("runner_profile" in parsed, false);
  assert.equal(parsed.builds[0]?.runner_profile, "windows-build");
  assert.equal("runner" in (parsed.builds[0] ?? {}), false);
});

test("release build manifest rejects concrete runner labels and duplicate assets", () => {
  assert.throws(() => parseReleaseBuildManifest({
    ...manifest,
    builds: [{
      ...manifest.builds[0],
      runner_profile: undefined,
      runner: "windows-latest",
    }],
  }));

  assert.throws(() => parseReleaseBuildManifest({
    ...manifest,
    builds: [
      manifest.builds[0],
      {
        ...manifest.builds[0],
        id: "windows-two",
      },
    ],
  }));
});

test("release build manifest rejects unsafe paths and target ambiguity", () => {
  assert.throws(() => parseReleaseBuildManifest({
    ...manifest,
    version_source: {
      type: "cargo-package",
      path: "../Cargo.toml",
    },
  }));

  assert.throws(() => parseReleaseBuildManifest({
    ...manifest,
    sbom_asset: "example.zip",
  }));
});
