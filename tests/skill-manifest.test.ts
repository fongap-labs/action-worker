import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  discoverSkills,
  parseFrontmatter,
  selectSkills,
  resolveAndVerifySkills,
} from "../scripts/resolve-agent-skills.ts";
import { composeAgentPrompt } from "../scripts/build-agent-prompt.ts";
import { CliError } from "../scripts/runtime-command.ts";

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function writeSkill(root: string, rel: string, frontmatter: string, body = "# Skill"): Promise<void> {
  const parts = rel.split("/");
  const dir = join(root, ...parts.slice(0, -1));
  await mkdir(dir, { recursive: true });
  await writeFile(join(root, ...parts), `---\n${frontmatter}\n---\n\n${body}\n`);
}

test("frontmatter parser extracts name, domain, baseline, and operations", () => {
  const skill = parseFrontmatter(
    "---\nname: bug-fix\ndescription: Root cause\ndomain: coding\nbaseline: false\noperations: [task, ci]\n---\n\n# Bug Fix",
    "skills/bug-fix/SKILL.md",
  );
  assert.equal(skill.name, "bug-fix");
  assert.equal(skill.domain, "coding");
  assert.equal(skill.baseline, false);
  assert.deepEqual(skill.operations, ["task", "ci"]);
});

test("frontmatter parser extracts always flag", () => {
  const skill = parseFrontmatter(
    "---\nname: agent-execution\ndescription: Baseline\nalways: true\n---",
    "skills/agent-execution/SKILL.md",
  );
  assert.equal(skill.always, true);
  assert.equal(skill.domain, "");
});

test("frontmatter parser rejects missing frontmatter", () => {
  assert.throws(() => parseFrontmatter("# No frontmatter", "x"), CliError);
});

test("frontmatter parser rejects skill without name", () => {
  assert.throws(
    () => parseFrontmatter("---\ndescription: only desc\n---", "x"),
    CliError,
  );
});

test("frontmatter parser rejects skill without always or domain", () => {
  assert.throws(
    () => parseFrontmatter("---\nname: orphan\ndescription: no domain\n---", "x"),
    CliError,
  );
});

test("selectSkills includes always skills for every domain", () => {
  const skills = [
    { path: "skills/agent-execution/SKILL.md", name: "agent-execution", always: true, domain: "", baseline: false, operations: [] },
    { path: "skills/code-minimality/SKILL.md", name: "code-minimality", always: false, domain: "coding", baseline: true, operations: [] },
    { path: "skills/writing/SKILL.md", name: "writing", always: false, domain: "writing", baseline: true, operations: [] },
  ];
  const coding = selectSkills(skills, "coding", "task");
  assert.deepEqual(coding, [
    "skills/agent-execution/SKILL.md",
    "skills/code-minimality/SKILL.md",
  ]);
  const writing = selectSkills(skills, "writing", "task");
  assert.deepEqual(writing, [
    "skills/agent-execution/SKILL.md",
    "skills/writing/SKILL.md",
  ]);
});

test("selectSkills includes domain baseline skills", () => {
  const skills = [
    { path: "skills/agent-execution/SKILL.md", name: "agent-execution", always: true, domain: "", baseline: false, operations: [] },
    { path: "skills/code-minimality/SKILL.md", name: "code-minimality", always: false, domain: "coding", baseline: true, operations: [] },
  ];
  const result = selectSkills(skills, "coding", "ci");
  assert.deepEqual(result, [
    "skills/agent-execution/SKILL.md",
    "skills/code-minimality/SKILL.md",
  ]);
});

test("selectSkills includes operation-specific skills only for matching operation", () => {
  const skills = [
    { path: "skills/agent-execution/SKILL.md", name: "agent-execution", always: true, domain: "", baseline: false, operations: [] },
    { path: "skills/bug-fix/SKILL.md", name: "bug-fix", always: false, domain: "coding", baseline: false, operations: ["task"] },
    { path: "skills/ci-diagnose/SKILL.md", name: "ci-diagnose", always: false, domain: "coding", baseline: false, operations: ["ci"] },
  ];
  const task = selectSkills(skills, "coding", "task");
  assert.deepEqual(task, [
    "skills/agent-execution/SKILL.md",
    "skills/bug-fix/SKILL.md",
  ]);
  const ci = selectSkills(skills, "coding", "ci");
  assert.deepEqual(ci, [
    "skills/agent-execution/SKILL.md",
    "skills/ci-diagnose/SKILL.md",
  ]);
});

test("selectSkills deduplicates while preserving order", () => {
  const skills = [
    { path: "skills/agent-execution/SKILL.md", name: "agent-execution", always: true, domain: "", baseline: false, operations: [] },
    { path: "skills/shared/SKILL.md", name: "shared", always: false, domain: "coding", baseline: true, operations: [] },
    { path: "skills/shared2/SKILL.md", name: "shared2", always: false, domain: "coding", baseline: false, operations: ["task"] },
  ];
  const result = selectSkills(skills, "coding", "task");
  assert.deepEqual(result, [
    "skills/agent-execution/SKILL.md",
    "skills/shared/SKILL.md",
    "skills/shared2/SKILL.md",
  ]);
});

test("discoverSkills scans committed skills/ directory", async () => {
  const skills = await discoverSkills(process.cwd());
  const names = skills.map((s) => s.name);
  assert.ok(names.includes("agent-execution"));
  assert.ok(names.includes("code-minimality"));
  assert.ok(names.includes("bug-fix"));
  assert.ok(names.includes("ci-diagnose"));
  assert.ok(names.includes("change-impact"));
  assert.ok(names.includes("pr-review"));
  assert.ok(names.includes("release-verify"));
  assert.ok(names.includes("writing"));
});

test("resolveAndVerifySkills resolves committed coding/task without config", async () => {
  const result = await resolveAndVerifySkills(process.cwd(), "coding", "task");
  assert.ok(result.includes("skills/agent-execution/SKILL.md"));
  assert.ok(result.includes("skills/code-minimality/SKILL.md"));
  assert.ok(result.includes("skills/bug-fix/SKILL.md"));
});

test("resolveAndVerifySkills resolves committed writing/task", async () => {
  const result = await resolveAndVerifySkills(process.cwd(), "writing", "task");
  assert.ok(result.includes("skills/agent-execution/SKILL.md"));
  assert.ok(result.includes("skills/writing/SKILL.md"));
  assert.ok(!result.includes("skills/code-minimality/SKILL.md"));
  assert.ok(!result.includes("skills/bug-fix/SKILL.md"));
});

test("resolveAndVerifySkills rejects unknown domain", async () => {
  await assert.rejects(
    () => resolveAndVerifySkills(process.cwd(), "nonexistent", "task"),
    CliError,
  );
});

test("resolveAndVerifySkills resolves operations with no operation-specific skills", async () => {
  const result = await resolveAndVerifySkills(process.cwd(), "writing", "review");
  assert.ok(result.includes("skills/agent-execution/SKILL.md"));
  assert.ok(result.includes("skills/writing/SKILL.md"));
});

test("every committed SKILL.md parses with valid frontmatter", async () => {
  const skills = await discoverSkills(process.cwd());
  for (const skill of skills) {
    assert.equal(await exists(skill.path), true, `missing skill file: ${skill.path}`);
  }
  assert.equal(skills.length, 8);
});

test("composeAgentPrompt concatenates CLAUDE.md and skill files", async () => {
  const tmpRoot = await mkdtemp(join(tmpdir(), "prompt-test-"));
  try {
    await writeFile(join(tmpRoot, "CLAUDE.md"), "# Governance Entry\n\nFollow these rules.");
    await writeSkill(tmpRoot, "skills/agent-execution/SKILL.md", "name: agent-execution\nalways: true");
    await writeSkill(tmpRoot, "skills/bug-fix/SKILL.md", "name: bug-fix\ndomain: coding\noperations: [task]");

    const prompt = await composeAgentPrompt(tmpRoot, [
      "skills/agent-execution/SKILL.md",
      "skills/bug-fix/SKILL.md",
    ]);
    assert.ok(prompt.includes("--- Governance Entry (CLAUDE.md) ---"));
    assert.ok(prompt.includes("Follow these rules."));
    assert.ok(prompt.includes("--- Skill: skills/agent-execution/SKILL.md ---"));
    assert.ok(prompt.includes("--- Skill: skills/bug-fix/SKILL.md ---"));
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
});

test("composeAgentPrompt works without CLAUDE.md", async () => {
  const tmpRoot = await mkdtemp(join(tmpdir(), "prompt-no-claude-"));
  try {
    await writeSkill(tmpRoot, "skills/test/SKILL.md", "name: test\nalways: true");
    const prompt = await composeAgentPrompt(tmpRoot, ["skills/test/SKILL.md"]);
    assert.ok(!prompt.includes("Governance Entry"));
    assert.ok(prompt.includes("# Skill"));
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
});

test("composeAgentPrompt throws on missing skill file", async () => {
  const tmpRoot = await mkdtemp(join(tmpdir(), "prompt-missing-"));
  try {
    await assert.rejects(() =>
      composeAgentPrompt(tmpRoot, ["skills/nonexistent/SKILL.md"]),
    );
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
});

test("task-dispatch contract allows optional agent_domain and operation", async () => {
  const contract = JSON.parse(
    await readFile("contracts/task-dispatch.json", "utf8"),
  ) as Record<string, unknown>;
  const properties = contract.properties as Record<string, unknown>;
  assert.ok("agent_domain" in properties);
  assert.ok("operation" in properties);
  const required = contract.required as string[];
  assert.ok(!required.includes("agent_domain"));
  assert.ok(!required.includes("operation"));
});

test("task dispatch workflow resolves skills without a manifest path argument", async () => {
  const workflow = await readFile(".github/workflows/handle-task-dispatch.yml", "utf8");
  assert.ok(workflow.includes('node scripts/resolve-agent-skills.ts "$AGENT_DOMAIN" "$OPERATION"'));
  assert.ok(workflow.includes("node scripts/build-agent-prompt.ts"));
  assert.ok(workflow.includes("AGENT_SYSTEM_PROMPT_PATH"));
  assert.ok(!workflow.includes("skills/skill-manifest.json"));
});