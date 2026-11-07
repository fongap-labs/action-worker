import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parseRunnerPolicy, resolveRunnerProfile } from "../scripts/runner-policy.ts";
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
  builds: [
    {
      id: "windows",
      runner_profile: "windows-build",
      target: "x86_64-pc-windows-msvc",
      script: ".github/scripts/release-build.ps1",
      assets: ["example.zip"],
      attest_asset: "example.zip",
    },
  ],
};

test("release build manifest keeps project metadata in the source repository", () => {
  const parsed = parseReleaseBuildManifest(manifest);
  assert.equal("runner_profile" in parsed, false);
  assert.equal(parsed.builds[0]?.runner_profile, "windows-build");
  assert.equal("runner" in (parsed.builds[0] ?? {}), false);
});

test("release build manifest rejects concrete runner labels and duplicate assets", () => {
  assert.throws(() =>
    parseReleaseBuildManifest({
      ...manifest,
      builds: [
        {
          ...manifest.builds[0],
          runner_profile: undefined,
          runner: "windows-latest",
        },
      ],
    })
  );

  assert.throws(() =>
    parseReleaseBuildManifest({
      ...manifest,
      builds: [
        manifest.builds[0],
        {
          ...manifest.builds[0],
          id: "windows-two",
        },
      ],
    })
  );
});

test("release build manifest cannot carry a version", () => {
  for (const field of ["version", "version_source"]) {
    assert.throws(
      () => parseReleaseBuildManifest({ ...manifest, [field]: "1.2.3" }),
      /manifest is invalid/
    );
  }
});

test("release build manifest rejects target ambiguity", () => {
  assert.throws(() =>
    parseReleaseBuildManifest({
      ...manifest,
      sbom_asset: "example.zip",
    })
  );
});

test("release build manifest may declare a repository-relative root", () => {
  for (const root of ["", "app", "projects/web"]) {
    assert.equal(parseReleaseBuildManifest({ ...manifest, root }).root, root);
  }
  assert.equal("root" in parseReleaseBuildManifest(manifest), false);
});

test("release build manifest rejects a root that leaves the repository", () => {
  for (const root of ["/projects/web", "projects/../secrets", "projects//web", 1]) {
    assert.throws(() => parseReleaseBuildManifest({ ...manifest, root }), /manifest is invalid/);
  }
});

test("release build script is a relative path from the product root", () => {
  for (const script of [
    ".github/scripts/release-build.ps1",
    "scripts/release-build.ps1",
    "build/win/release.ps1",
    "scripts/build-release.mjs",
  ]) {
    const parsed = parseReleaseBuildManifest({
      ...manifest,
      builds: [{ ...manifest.builds[0], script }],
    });
    assert.equal(parsed.builds[0]?.script, script);
  }
});

test("release build script must be a PowerShell or Node script inside the repository", () => {
  for (const script of [
    "",
    "release-build.sh",
    "release-build",
    "../outside/release-build.ps1",
    "/absolute/release-build.ps1",
    "scripts/../../release-build.ps1",
  ]) {
    assert.throws(
      () =>
        parseReleaseBuildManifest({
          ...manifest,
          builds: [{ ...manifest.builds[0], script }],
        }),
      /matrix entry is invalid/,
      `script accepted: ${script}`
    );
  }
});

test("portable Node builds may opt out of the Rust toolchain without affecting legacy builds", () => {
  const linux = {
    ...manifest.builds[0],
    id: "portable",
    runner_profile: "linux-standard",
    target: "portable",
    script: "scripts/build-release.mjs",
    setup_rust: false,
  };
  assert.equal(
    parseReleaseBuildManifest({ ...manifest, builds: [linux] }).builds[0]?.setup_rust,
    false
  );
  assert.equal(parseReleaseBuildManifest(manifest).builds[0]?.setup_rust, undefined);
  for (const setup_rust of ["false", 0, null]) {
    assert.throws(
      () =>
        parseReleaseBuildManifest({
          ...manifest,
          builds: [{ ...linux, setup_rust }],
        }),
      /matrix entry is invalid/
    );
  }
});

test("business-owned release matrix resolves across enabled central platform profiles", async () => {
  const policy = parseRunnerPolicy(JSON.parse(await readFile("policies/runner.json", "utf8")));
  const windows = manifest.builds[0];
  assert.ok(windows);
  const builds = [
    windows,
    {
      ...windows,
      id: "linux",
      runner_profile: "linux-standard",
      target: "x86_64-unknown-linux-gnu",
      script: "scripts/release-build.mjs",
      assets: ["example-linux.tar.gz"],
      attest_asset: "example-linux.tar.gz",
    },
    {
      ...windows,
      id: "macos",
      runner_profile: "macos-build",
      target: "universal-apple-darwin",
      script: "scripts/release-build.mjs",
      assets: ["example-macos.dmg"],
      attest_asset: "example-macos.dmg",
    },
  ];
  const parsed = parseReleaseBuildManifest({ ...manifest, builds });
  assert.deepEqual(
    parsed.builds.map((build) => build.id),
    ["windows", "linux", "macos"]
  );
  for (const build of parsed.builds) {
    const resolved = resolveRunnerProfile(policy, build.runner_profile);
    assert.equal(resolved.profile.trust_domain, "sandbox");
    assert.equal(resolved.profile.enabled, true);
  }
});

test("product acceptance script is optional and must stay within the product root", () => {
  assert.equal(parseReleaseBuildManifest(manifest).builds[0]?.acceptance_script, undefined);
  for (const script of ["scripts/verify.mjs", "scripts/verify.ps1"]) {
    const parsed = parseReleaseBuildManifest({
      ...manifest,
      builds: [{ ...manifest.builds[0], acceptance_script: script }],
    });
    assert.equal(parsed.builds[0]?.acceptance_script, script);
  }
  for (const script of ["", "../verify.mjs", "/tmp/verify.ps1", "scripts/verify.sh", 42]) {
    assert.throws(
      () =>
        parseReleaseBuildManifest({
          ...manifest,
          builds: [{ ...manifest.builds[0], acceptance_script: script }],
        }),
      /matrix entry is invalid/
    );
  }
});
