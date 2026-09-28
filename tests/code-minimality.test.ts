import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { test } from "node:test";

async function text(path: string): Promise<string> {
  return await readFile(path, "utf8");
}

async function json(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await text(path)) as Record<string, unknown>;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function requireText(content: string, values: readonly string[]): void {
  for (const value of values) {
    assert.ok(content.includes(value), `missing contract text: ${value}`);
  }
}

type RuleEntry = { path?: unknown; merge_system_rule?: unknown; rule?: unknown };

async function minimalityRuleTexts(path: string): Promise<string[]> {
  const value = await json(path);
  const entries = Array.isArray(value.rules) ? (value.rules as RuleEntry[]) : [];
  return entries
    .filter(
      (entry) =>
        typeof entry.rule === "string" && (entry.rule as string).includes("code-minimality")
    )
    .map((entry) => entry.rule as string);
}

async function allRuleEntries(path: string): Promise<RuleEntry[]> {
  const value = await json(path);
  return Array.isArray(value.rules) ? (value.rules as RuleEntry[]) : [];
}

const minimalityReviewRuleFiles = ["rules/code.json", "rules/architecture.json"];
const allReviewRuleFiles = [
  "rules/code.json",
  "rules/architecture.json",
  "rules/security.json",
  "rules/release.json",
  "rules/workflow.json",
];

test("code-minimality skill carries the reuse ladder, minimal change set, deletion, and root-cause rules", async () => {
  const skill = await text("skills/code-minimality/SKILL.md");
  requireText(skill, [
    "name: code-minimality",
    "minimal necessary implementation, not the least code",
    "existing code, helper, module, or tool",
    "standard library",
    "platform-native capability",
    "already-installed dependency",
    "fewest files",
    "fewest new abstractions",
    "smallest impact radius",
    "wrapper, adapter, factory, registry, manager, service",
    "delete it instead of adding a compatibility layer",
    "repair the root cause",
    "Do not stack a workaround on the symptom, then a special case, then another fallback.",
    "A potential future need is not a current requirement.",
  ]);
});

test("code-minimality states the hard safety boundary that fewer lines can never cut", async () => {
  const skill = await text("skills/code-minimality/SKILL.md");
  requireText(skill, [
    "security",
    "input validation",
    "error handling",
    "permission checks",
    "access control",
    "data-loss prevention",
    "auditability",
    "accessibility",
    "release safety",
    "deterministic gates",
    "advisory for agent execution and AI review",
    "must not bypass or lower CI, security, release, permission, or repository-protection gates",
    "never auto-approves a change",
    "Deterministic gates remain the only merge authority.",
  ]);
});

test("code-minimality is registered in the skills table and the agent execution chain", async () => {
  const readme = await text("skills/README.md");
  requireText(readme, [
    "[code-minimality](code-minimality/SKILL.md)",
    "rules/code.json",
    "rules/architecture.json",
    "DietrichGebert/ponytail",
    "MIT License",
    "extra model call",
    "A skill must not weaken deterministic gates or override project-specific mandatory policy.",
  ]);
  const guide = await text("CLAUDE.md");
  requireText(guide, ["skills/agent-execution/SKILL.md", "skills/*/SKILL.md"]);
});

test("each review rule file carries a single merged **/* entry so OpenCodeReview applies it", async () => {
  // OpenCodeReview v1.12.9 applies only the first matching rule per path pattern;
  // a second entry with the same pattern is silently dropped. Each review rule file
  // must therefore keep exactly one "**/*" entry with the guidance merged into it.
  for (const path of allReviewRuleFiles) {
    const entries = await allRuleEntries(path);
    assert.ok(entries.length > 0, `${path} must define at least one rule`);
    const starEntries = entries.filter((entry) => entry.path === "**/*");
    assert.equal(starEntries.length, 1, `${path} must have exactly one "**/*" rule entry`);
    assert.equal(
      starEntries[0]?.merge_system_rule,
      true,
      `${path} "**/*" entry must merge into the system rule`
    );
  }
});

test("code and architecture reviews detect duplicate implementation, over-abstraction, and unnecessary dependencies", async () => {
  for (const path of minimalityReviewRuleFiles) {
    const entries = await allRuleEntries(path);
    assert.equal(entries.length, 1, `${path} must carry exactly one rule entry`);
    const rule = typeof entries[0]?.rule === "string" ? (entries[0].rule as string) : "";
    // minimality guidance is merged into the same single entry as the review focus
    if (path === "rules/code.json") {
      assert.ok(
        rule.includes("Focus on correctness"),
        `${path} must keep the code review focus in the merged entry`
      );
    } else {
      assert.ok(
        rule.includes("Review for breaking changes"),
        `${path} must keep the architecture review focus in the merged entry`
      );
    }
    assert.ok(
      rule.includes("code-minimality"),
      `${path} must merge code-minimality into the single rule entry`
    );
    assert.match(rule, /reimplement/, `${path} must flag duplicate implementation`);
    assert.match(rule, /reused/, `${path} must require reuse of existing capability`);
    for (const layer of ["wrapper", "adapter", "factory", "registry", "manager", "service"]) {
      assert.ok(rule.includes(layer), `${path} must flag unnecessary ${layer} layers`);
    }
    assert.match(
      rule,
      /third-party dependency|new dependency/,
      `${path} must flag unnecessary new dependencies`
    );
    assert.match(rule, /standard library/, `${path} must prefer the standard library`);
    assert.match(rule, /platform-native/, `${path} must prefer platform-native capability`);
    assert.match(rule, /shrink/, `${path} must check whether the change scope can shrink`);
    assert.match(rule, /delete/, `${path} must check whether code can be deleted instead`);
    assert.match(rule, /YAGNI/, `${path} must flag speculative extension`);
    assert.match(rule, /root cause/, `${path} must require root-cause bug fixes`);
    assert.match(rule, /workaround/, `${path} must flag symptom workarounds`);
    assert.match(rule, /fallback/, `${path} must flag fallback stacking`);
    for (const tag of ["delete", "reuse", "stdlib", "native", "yagni", "shrink", "root-cause"]) {
      assert.ok(rule.includes(tag), `${path} must define the ${tag} finding category`);
    }
    assert.match(
      rule,
      /Keep the existing review output format/,
      `${path} must stay compatible with the review output protocol`
    );
  }
});

test("minimality review rules never authorize cutting safety requirements", async () => {
  for (const path of minimalityReviewRuleFiles) {
    const rule = (await minimalityRuleTexts(path))[0] ?? "";
    requireText(rule, [
      "advisory only",
      "input validation",
      "error handling",
      "permission",
      "security",
      "auditability",
      "accessibility",
      "deterministic gate",
    ]);
  }
});

test("code-minimality leaves deterministic gates and the single AI review call intact", async () => {
  const review = await json("policies/review.json");
  const agents = review.agents as Record<string, Record<string, unknown>>;
  assert.deepEqual(Object.keys(agents).sort(), [
    "architecture",
    "code",
    "release",
    "security",
    "workflow",
  ]);
  assert.equal(agents.code?.rule, "code.json");
  assert.equal(agents.architecture?.rule, "architecture.json");
  assert.equal(agents.security?.rule, "security.json");
  assert.equal(agents.workflow?.rule, "workflow.json");
  assert.equal(agents.release?.rule, "release.json");
  const runtime = review.runtime as Record<string, unknown>;
  assert.equal(runtime.concurrency, 1);
  assert.equal(runtime.resume_attempts, 3);

  const reviewRunner = await text("scripts/run-ai-review.ts");
  assert.match(reviewRunner, /AI Review \(advisory\)/);
  assert.match(reviewRunner, /merge gate: unaffected/);
  assert.doesNotMatch(reviewRunner, /ponytail/i);

  const workflow = await text(".github/workflows/handle-pr-dispatch.yml");
  assert.equal((workflow.match(/node scripts\/run-ai-review\.ts/g) ?? []).length, 1);
  assert.doesNotMatch(workflow, /ponytail/i);

  for (const path of ["rules/security.json", "rules/release.json", "rules/workflow.json"]) {
    assert.deepEqual(
      await minimalityRuleTexts(path),
      [],
      `${path} must not carry code-minimality rules`
    );
  }
});

test("code-minimality introduces no Ponytail runtime, dependency, or host-specific code", async () => {
  const pkg = await text("package.json");
  assert.doesNotMatch(pkg, /ponytail/i);
  const lock = await text("package-lock.json");
  assert.doesNotMatch(lock, /ponytail/i);
  assert.equal(await exists(".opencode"), false);
  assert.equal(await exists("skills/ponytail"), false);
  const skillsReadme = await text("skills/README.md");
  assert.ok(
    skillsReadme.includes(
      "no Ponytail runtime, dependency, plugin, command, or implementation code is included"
    )
  );
  const skill = await text("skills/code-minimality/SKILL.md");
  requireText(skill, [
    "DietrichGebert/ponytail",
    "MIT License",
    "No Ponytail runtime, dependency, plugin, command, state file, or implementation code is included.",
  ]);
});
