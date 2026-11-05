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

test("human governance documents use Chinese-only second and third-level headings", async () => {
  const violations: string[] = [];
  const paths = (await trackedMarkdown()).filter(
    (path) =>
      path.startsWith("docs/") || ["README.md", "SECURITY.md", "CONTRIBUTING.md"].includes(path)
  );
  for (const path of paths) {
    const lines = (await readFile(path, "utf8")).split("\n");
    let inFence = false;
    lines.forEach((line, index) => {
      if (line.trimStart().startsWith("```")) {
        inFence = !inFence;
        return;
      }
      if (inFence || !/^#{2,3} /.test(line)) return;
      const normalized = line.replace(/^#{2,3} (?:\d+(?:\.\d+)*\.\s*)?/, "");
      if (!/\p{Script=Han}/u.test(normalized) || /[A-Za-z]/.test(normalized)) {
        violations.push(`${path}:${index + 1}: ${line}`);
      }
    });
  }
  assert.deepEqual(violations, [], "second and third-level headings must be concise Chinese");
});

test("authoritative governance rules use short Chinese sentences and paired examples", async () => {
  const files = [
    "docs/00_GOVERNANCE_OVERVIEW.md",
    "docs/01_SHARED_GOVERNANCE.md",
    "docs/02_REPOSITORY_GOVERNANCE.md",
    "docs/03_NAMING_CONVENTIONS.md",
    "docs/04_CHANGELOG_CONVENTIONS.md",
    "docs/05_INTEGRATION_GUIDE.md",
    "docs/GOVERNANCE_CHANGE_CHECKLIST.md",
  ];
  const violations: string[] = [];
  for (const path of files) {
    const lines = (await readFile(path, "utf8")).split("\n");
    let fenced = false;
    let chapter = "";
    let body: string[] = [];
    const verify = () => {
      if (!chapter) return;
      const first = body.find((line) => line.trim() !== "");
      if (!first || [...first].length > 20 || !containsHan(first)) {
        violations.push(`${path}: ${chapter}: summary must be Chinese and at most 20 characters`);
      }
      const wrong = body.indexOf("### ❌ 错误做法 / 反面教材");
      const right = body.indexOf("### ✅ 正确做法 / 规范范例");
      if (
        wrong < 0 ||
        right <= wrong ||
        !body.slice(wrong + 1, right).some((line) => line.startsWith("```")) ||
        !body.slice(right + 1).some((line) => line.startsWith("```"))
      ) {
        violations.push(`${path}: ${chapter}: missing contrasting code examples`);
      }
    };
    for (const line of lines) {
      if (line.startsWith("```")) {
        fenced = !fenced;
      }
      if (!fenced && /^## \d+\. /.test(line)) {
        verify();
        chapter = line;
        body = [];
      } else if (chapter) {
        body.push(line);
      }
    }
    verify();
  }
  assert.deepEqual(violations, []);
});
