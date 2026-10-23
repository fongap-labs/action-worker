import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { promisify } from "node:util";
import { containsHan } from "../scripts/validate-engineering-language.ts";

const run = promisify(execFile);

// Machine-read documents: agent entry points and reusable agent skills. They are English.
const machineRead = [/^CLAUDE\.md$/, /^AGENTS\.md$/, /^skills\//];
// Test packs hold product fixtures of the managed repositories, not Action Worker documentation.
const productFixtures = /^tests\/packs\//;
const changelog = /^CHANGELOG\.md$/;
// Chinese localization files are retired: the Chinese document is the only human-facing version.
const localization = /\.zh-CN\.md$/;

async function trackedMarkdown(): Promise<string[]> {
  const { stdout } = await run("git", ["ls-files", "*.md"]);
  return stdout.split("\n").filter((path) => path !== "" && !productFixtures.test(path));
}

function isMachineRead(path: string): boolean {
  return machineRead.some((pattern) => pattern.test(path));
}

test("machine-read Action Worker documents are written in English", async () => {
  const violations: string[] = [];
  for (const path of await trackedMarkdown()) {
    if (!isMachineRead(path)) continue;
    const lines = (await readFile(path, "utf8")).split("\n");
    lines.forEach((line, index) => {
      if (containsHan(line)) violations.push(`${path}:${index + 1}`);
    });
  }
  assert.deepEqual(violations, [], "Chinese text does not belong in machine-read documents");
});

test("human-facing Action Worker documents are written in Chinese", async () => {
  const missing: string[] = [];
  for (const path of await trackedMarkdown()) {
    // The CHANGELOG is a release record: its language is checked per entry by validate-change-record.
    if (isMachineRead(path) || changelog.test(path)) continue;
    const text = await readFile(path, "utf8");
    if (!containsHan(text)) missing.push(path);
  }
  assert.deepEqual(missing, [], "human-facing documents must be written in Chinese");
});

test("no Chinese localization copies are kept beside the Chinese documents", async () => {
  const { stdout } = await run("git", ["ls-files", "*.zh-CN.md"]);
  const copies = stdout.split("\n").filter((path) => localization.test(path));
  assert.deepEqual(
    copies,
    [],
    "Chinese documents have one authoritative file, not a localization copy"
  );
});
