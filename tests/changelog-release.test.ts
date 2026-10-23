import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertChineseSummary,
  parseEntry,
  promoteUnreleased,
} from "../scripts/changelog-release.ts";
import { CliError } from "../scripts/runtime-command.ts";

const categories = ["新增", "变更", "弃用", "移除", "修复", "安全"];

test("an entry names one category, optional attributes and a Chinese summary", () => {
  assert.deepEqual(parseEntry("- 修复: 修复路由重试。"), {
    category: "修复",
    attributes: [],
    summary: "修复路由重试。",
  });
  assert.deepEqual(parseEntry("- 新增 [breaking, migration]: 替换认证配置格式。"), {
    category: "新增",
    attributes: ["breaking", "migration"],
    summary: "替换认证配置格式。",
  });
  // The shape is checked here; an unknown category such as the previous `fix` type is refused by
  // validate-change-record, which compares the category with release.json.
  assert.equal(parseEntry("- fix: repair the router.")?.category, "fix");
  assert.equal(categories.includes("fix"), false);
  assert.equal(parseEntry("- 修复 没有冒号"), null);
});

test("pending fragments are released after the unreleased entries, in category order", () => {
  const before = "# Changelog\n\n## [Unreleased]\n\n- 修复: 已在未发布区的条目。\n\n## [0.1.0]\n";
  const after = promoteUnreleased(before, {
    version: "0.2.0",
    date: "2026-10-23",
    releaseUrl: "https://example.invalid/releases/0.2.0",
    categories,
    fragments: [
      "- 安全 [security]: 收紧密钥权限。\n",
      "- 新增: 增加导出命令。\n- 修复: 修正超时。\n",
    ],
  });
  const release = after.slice(after.indexOf("## [0.2.0]"), after.indexOf("## [0.1.0]"));
  assert.deepEqual(
    release.split("\n").filter((line) => line.startsWith("### ") || line.startsWith("- ")),
    [
      "### 新增",
      "- 增加导出命令。",
      "### 修复",
      "- 已在未发布区的条目。",
      "- 修正超时。",
      "### 安全",
      "- [security] 收紧密钥权限。",
    ]
  );
  assert.throws(
    () =>
      promoteUnreleased(before, {
        version: "0.2.0",
        date: "2026-10-23",
        releaseUrl: "https://example.invalid/releases/0.2.0",
        categories,
        fragments: ["不是条目的一行。\n"],
      }),
    /changelog fragment holds a line that is not an entry/
  );
});

test("a summary must be Chinese text and must not carry mojibake", () => {
  assert.doesNotThrow(() => assertChineseSummary("修复 Settings ▸ Privacy 的显示。"));
  assert.throws(() => assertChineseSummary("repair the router."), CliError);
  assert.throws(() => assertChineseSummary("修复 Settings â–?Privacy"), CliError);
  assert.throws(() => assertChineseSummary("修复 range �"), CliError);
  assert.throws(() => assertChineseSummary("修复 wrong dash â€“ here"), CliError);
});

test("promoting Unreleased moves every entry into a linked version section in category order", () => {
  const before = [
    "# Changelog",
    "",
    "## [Unreleased]",
    "",
    "- 修复: 修复路由重试。",
    "- 新增 [breaking]: 替换认证配置格式。",
    "- 安全 [security]: 收紧 OAuth 回调校验。",
    "- 新增: 增加导出命令。",
    "",
    "## [0.1.0](https://github.com/fongap-labs/example/releases/tag/example-v0.1.0) - 2026-09-18",
    "",
    "### 修复",
    "",
    "- 旧条目。",
    "",
  ].join("\n");

  const after = promoteUnreleased(before, {
    version: "0.2.0",
    date: "2026-10-23",
    releaseUrl: "https://github.com/fongap-labs/example/releases/tag/example-v0.2.0",
    categories,
  });

  assert.equal(
    after,
    [
      "# Changelog",
      "",
      "## [Unreleased]",
      "",
      "## [0.2.0](https://github.com/fongap-labs/example/releases/tag/example-v0.2.0) - 2026-10-23",
      "",
      "### 新增",
      "",
      "- [breaking] 替换认证配置格式。",
      "- 增加导出命令。",
      "",
      "### 修复",
      "",
      "- 修复路由重试。",
      "",
      "### 安全",
      "",
      "- [security] 收紧 OAuth 回调校验。",
      "",
      "## [0.1.0](https://github.com/fongap-labs/example/releases/tag/example-v0.1.0) - 2026-09-18",
      "",
      "### 修复",
      "",
      "- 旧条目。",
      "",
    ].join("\n")
  );
});

test("promoting refuses an empty Unreleased and an unknown category", () => {
  const options = {
    version: "0.2.0",
    date: "2026-10-23",
    releaseUrl: "https://example.invalid",
    categories,
  };
  assert.throws(
    () => promoteUnreleased("# Changelog\n\n## [Unreleased]\n\n## [0.1.0]\n", options),
    /No CHANGELOG entries/
  );
  assert.throws(
    () => promoteUnreleased("# Changelog\n\n## [Unreleased]\n- 其他: 未知类别。\n", options),
    /unknown category/
  );
  assert.throws(
    () =>
      promoteUnreleased("# Changelog\n\n## [Unreleased]\n- 修复: 有效。\n", {
        ...options,
        categories: ["新增"],
      }),
    /unknown category/
  );
});
