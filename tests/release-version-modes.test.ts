import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertReleaseChange,
  betaEntriesOf,
  promoteUnreleased,
} from "../scripts/changelog-release.ts";
import { buildReleaseManifest } from "../scripts/package-release-build.ts";
import {
  normalizeReleaseVersion,
  parseReleaseBuildManifest,
} from "../scripts/validate-release-build-request.ts";

const categories = ["新增", "变更", "弃用", "移除", "修复", "安全"];
const url = (version: string) =>
  `https://github.com/fongap-labs/example/releases/tag/example-v${version}`;

test("a version is either formal X.Y.Z or a beta X.Y.Z-beta.N, with an optional leading v", () => {
  assert.equal(normalizeReleaseVersion("1.2.3"), "1.2.3");
  assert.equal(normalizeReleaseVersion("v1.2.3"), "1.2.3");
  assert.equal(normalizeReleaseVersion("1.2.3-beta.1"), "1.2.3-beta.1");
  assert.equal(normalizeReleaseVersion("v0.1.0-beta.12"), "0.1.0-beta.12");
  for (const invalid of ["1.2.3-rc.1", "1.2.3-beta.0", "1.2.3-beta.01", "1.2.3+build.1", "1.2"]) {
    assert.throws(() => normalizeReleaseVersion(invalid), /X\.Y\.Z/, invalid);
  }
});

test("a beta is packaged as a pre-release and a formal version is not", () => {
  const manifest = parseReleaseBuildManifest({
    schema_version: 1,
    artifact_name: "example-release",
    target_repository: "fongap-labs/example",
    release_key: "example",
    release_name: "Example",
    release_notes: "",
    license_expression: "Apache-2.0",
    node_version_file: ".nvmrc",
    python_version_file: ".python-version",
    sbom_asset: "example.sbom.cdx.json",
    builds: [
      {
        id: "windows-portable",
        runner_profile: "windows-build",
        target: "x86_64-pc-windows-msvc",
        script: ".github/scripts/release-build.ps1",
        assets: ["example-windows-x64-portable.zip"],
        attest_asset: "example-windows-x64-portable.zip",
      },
    ],
  });
  const assets = [{ name: "example-windows-x64-portable.zip", sha256: "a".repeat(64) }];
  assert.equal(buildReleaseManifest(manifest, "0.1.0-beta.1", assets).prerelease, true);
  assert.equal(buildReleaseManifest(manifest, "0.1.0", assets).prerelease, false);
});

test("a formal release lists the entries of its betas, and a beta lists only its own", () => {
  const base = [
    "# Changelog",
    "",
    "## [Unreleased]",
    "",
    "- 修复: 修正超时。",
    "",
    `## [0.1.0-beta.2](${url("0.1.0-beta.2")}) - 2026-10-22`,
    "",
    "### 新增",
    "",
    "- [breaking] 替换配置格式。",
    "",
    `## [0.1.0-beta.1](${url("0.1.0-beta.1")}) - 2026-10-21`,
    "",
    "### 修复",
    "",
    "- 修复路由重试。",
    "",
    `## [0.0.9](${url("0.0.9")}) - 2026-10-01`,
    "",
    "### 修复",
    "",
    "- 旧条目。",
    "",
  ].join("\n");

  const formal = promoteUnreleased(base, {
    version: "0.1.0",
    date: "2026-10-23",
    releaseUrl: url("0.1.0"),
    categories,
  });
  const section = formal.slice(formal.indexOf("## [0.1.0]("), formal.indexOf("## [0.1.0-beta.2]"));
  assert.match(section, /### 新增\n\n- \[breaking\] 替换配置格式。/);
  assert.match(section, /### 修复\n\n- 修复路由重试。\n- 修正超时。/);
  assert.doesNotMatch(section, /旧条目/, "an older formal release is not repeated");

  const beta = promoteUnreleased(base, {
    version: "0.1.0-beta.3",
    date: "2026-10-23",
    releaseUrl: url("0.1.0-beta.3"),
    categories,
  });
  const betaSection = beta.slice(
    beta.indexOf("## [0.1.0-beta.3]("),
    beta.indexOf("## [0.1.0-beta.2]")
  );
  assert.doesNotMatch(
    betaSection,
    /替换配置格式|修复路由重试/,
    "a beta does not pull in other betas"
  );
  assert.match(betaSection, /修正超时/);
});

test("the beta entries read back from their sections keep category, attributes and summary", () => {
  const content = `## [0.2.0-beta.1](${url("0.2.0-beta.1")}) - 2026-10-20\n\n### 安全\n\n- [security] 收紧权限。\n`;
  assert.deepEqual(betaEntriesOf(content, "0.2.0", categories), [
    { category: "安全", attributes: ["security"], summary: "收紧权限。" },
  ]);
  assert.deepEqual(betaEntriesOf(content, "0.2.0-beta.1", categories), []);
});

test("a formal release change that lists beta entries still passes the exact check", () => {
  const base = [
    "# Changelog",
    "",
    "## [Unreleased]",
    "",
    `## [0.3.0-beta.1](${url("0.3.0-beta.1")}) - 2026-10-20`,
    "",
    "### 新增",
    "",
    "- 增加导出命令。",
    "",
  ].join("\n");
  const head = promoteUnreleased(base, {
    version: "0.3.0",
    date: "2026-10-23",
    releaseUrl: url("0.3.0"),
    categories,
    fragments: ["- 修复: 修正超时。\n"],
  });
  assert.equal(
    assertReleaseChange({
      baseChangelog: base,
      headChangelog: head,
      removedFragments: ["- 修复: 修正超时。\n"],
      categories,
    }).version,
    "0.3.0"
  );
});
