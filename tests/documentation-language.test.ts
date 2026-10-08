import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { promisify } from "node:util";
import { containsHan } from "../scripts/validate-engineering-language.ts";

const run = promisify(execFile);

// A localization file translates an English original and is the only place for Chinese text.
const localization = /\.zh-CN\.md$/;
// The language switch at the top of an English document names the Chinese version in Chinese.
const languageSwitch = /\[\**\u7b80\u4f53\u4e2d\u6587\**\]\([^)]*\.zh-CN\.md\)/g;
// Test packs hold product fixtures of the managed repositories, not Action Worker documentation.
const productFixtures = /^tests\/packs\//;

async function trackedMarkdown(): Promise<string[]> {
  const { stdout } = await run("git", ["ls-files", "*.md"]);
  return stdout
    .split("\n")
    .filter((path) => path !== "" && !productFixtures.test(path) && !localization.test(path));
}

test("Action Worker documentation is written in English", async () => {
  const violations: string[] = [];
  for (const path of await trackedMarkdown()) {
    const lines = (await readFile(path, "utf8")).split("\n");
    lines.forEach((line, index) => {
      if (containsHan(line.replace(languageSwitch, ""))) {
        violations.push(`${path}:${index + 1}`);
      }
    });
  }
  assert.deepEqual(violations, [], "Chinese text belongs only in a *.zh-CN.md localization file");
});

test("every Chinese localization file translates an English original", async () => {
  const { stdout } = await run("git", ["ls-files", "*.zh-CN.md"]);
  for (const path of stdout.split("\n").filter(Boolean)) {
    const original = path.replace(localization, ".md");
    await assert.doesNotReject(readFile(original, "utf8"), `${path} has no English original`);
  }
});
