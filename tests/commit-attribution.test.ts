import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { runText } from "../scripts/runtime-command.ts";
import { assertAttributionFree, validateCommitMessage } from "../scripts/validate-change-record.ts";

const policyDir = resolve("policies");

type Identity = { name: string; email: string };

async function git(root: string, args: readonly string[], env: NodeJS.ProcessEnv = {}) {
  return await runText("git", ["-c", "commit.gpgsign=false", ...args], {
    cwd: root,
    env: { ...process.env, ...env },
  });
}

function identityEnv(author: Identity, committer: Identity = author): NodeJS.ProcessEnv {
  return {
    GIT_AUTHOR_NAME: author.name,
    GIT_AUTHOR_EMAIL: author.email,
    GIT_COMMITTER_NAME: committer.name,
    GIT_COMMITTER_EMAIL: committer.email,
  };
}

async function fixture(context: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), "attribution-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const human: Identity = { name: "Ada", email: "ada@example.com" };
  await git(root, ["init", "-q"]);
  await writeFile(join(root, "README.md"), "# Fixture\n", "utf8");
  await git(root, ["add", "."], identityEnv(human));
  await git(root, ["commit", "-qm", "base"], identityEnv(human));
  const base = await git(root, ["rev-parse", "HEAD"]);
  return { root, base, human };
}

let counter = 0;

async function commit(
  root: string,
  message: string,
  author: Identity,
  committer: Identity = author
): Promise<string> {
  counter += 1;
  await writeFile(join(root, `change-${counter}.txt`), `${counter}\n`, "utf8");
  await git(root, ["add", "."], identityEnv(author, committer));
  await git(root, ["commit", "-qm", message], identityEnv(author, committer));
  return await git(root, ["rev-parse", "HEAD"]);
}

const claude: Identity = { name: "Claude", email: "noreply@anthropic.com" };

test("accepts a human commit with a clean title and message", async (context) => {
  const { root, base, human } = await fixture(context);
  const head = await commit(root, "chore: clarify setup\n\n澄清安装步骤。", human);
  await assertAttributionFree("chore: clarify setup", base, head, root, policyDir);
});

test("rejects a commit whose author is an AI agent", async (context) => {
  const { root, base, human } = await fixture(context);
  const head = await commit(root, "chore: clarify setup", claude, human);
  await assert.rejects(
    assertAttributionFree("chore: clarify setup", base, head, root, policyDir),
    /author or committer names an AI agent or model: Claude/
  );
});

test("rejects a commit whose committer is an AI agent", async (context) => {
  const { root, base, human } = await fixture(context);
  const head = await commit(root, "chore: clarify setup", human, claude);
  await assert.rejects(
    assertAttributionFree("chore: clarify setup", base, head, root, policyDir),
    /author or committer names an AI agent or model: Claude/
  );
});

test("rejects an AI agent identity that appears only in the email address", async (context) => {
  const { root, base } = await fixture(context);
  const head = await commit(root, "chore: clarify setup", {
    name: "Ada",
    email: "noreply@anthropic.com",
  });
  await assert.rejects(
    assertAttributionFree("chore: clarify setup", base, head, root, policyDir),
    /author or committer names an AI agent or model: anthropic/
  );
});

test("rejects a Co-Authored-By trailer that names an AI agent", async (context) => {
  const { root, base, human } = await fixture(context);
  const head = await commit(
    root,
    "chore: clarify setup\n\n澄清安装步骤。\n\nCo-Authored-By: Claude",
    human
  );
  await assert.rejects(
    assertAttributionFree("chore: clarify setup", base, head, root, policyDir),
    /trailer Co-Authored-By names an AI agent or model: Claude/
  );
});

test("accepts a Co-Authored-By trailer that names a human", async (context) => {
  const { root, base, human } = await fixture(context);
  const head = await commit(
    root,
    "chore: clarify setup\n\n协作完成文档整理。\n\nCo-Authored-By: Grace Hopper",
    human
  );
  await assertAttributionFree("chore: clarify setup", base, head, root, policyDir);
});

test("rejects generated-with and assisted-by attribution lines", async (context) => {
  const { root, base, human } = await fixture(context);
  const generated = await commit(root, "chore: clarify setup\n\nGenerated with [Tool]", human);
  await assert.rejects(
    assertAttributionFree("chore: clarify setup", base, generated, root, policyDir),
    /Generated with/
  );
  const robot = await commit(root, "chore: clarify setup\n\n🤖 drafted", human);
  await assert.rejects(
    assertAttributionFree("chore: clarify setup", base, robot, root, policyDir),
    /🤖/
  );
});

test("allows agent names in the PR title and in commit prose", async (context) => {
  const { root, base, human } = await fixture(context);
  const head = await commit(
    root,
    "chore: explain how Claude reads CLAUDE.md\n\nClaude Code 和 Codex 的用法均在智能体指南中说明。",
    human
  );
  await assertAttributionFree(
    "chore: explain how Claude reads CLAUDE.md",
    base,
    head,
    root,
    policyDir
  );
});

test("identity-only words are checked in identities but not in commit messages", async (context) => {
  const { root, base, human } = await fixture(context);
  const message = await commit(
    root,
    "fix: keep the cursor position in the editor\n\n修复编辑器光标位置。",
    human
  );
  await assertAttributionFree(
    "fix: keep the cursor position in the editor",
    base,
    message,
    root,
    policyDir
  );
  const identity = await commit(root, "chore: clarify setup", {
    name: "Devin Lee",
    email: "devin@example.com",
  });
  await assert.rejects(
    assertAttributionFree("chore: clarify setup", base, identity, root, policyDir),
    /names an AI agent or model: Devin/
  );
});

test("allows an AI agent name in the PR title but blocks an attribution line", async (context) => {
  const { root, base, human } = await fixture(context);
  const head = await commit(root, "feat: add support\n\n增加必要支持。", human);
  await assertAttributionFree("feat: add Claude support", base, head, root, policyDir);
  await assert.rejects(
    assertAttributionFree("🤖 feat: add support", base, head, root, policyDir),
    /PR title is an attribution line: 🤖 feat: add support/
  );
  await assert.rejects(
    assertAttributionFree("Generated with Codex: add support", base, head, root, policyDir),
    /PR title is an attribution line: Generated with Codex/
  );
});

test("skips merge commits whose subject names the merged branch", async (context) => {
  const { root, base, human } = await fixture(context);
  await git(root, ["switch", "-q", "-c", "claude/fix-readme"], identityEnv(human));
  await commit(root, "chore: fix readme wording\n\n修正文档表述。", human);
  await git(root, ["switch", "-q", "-"], identityEnv(human));
  await git(
    root,
    ["merge", "-q", "--no-ff", "claude/fix-readme", "-m", "Merge branch 'claude/fix-readme'"],
    identityEnv(human)
  );
  const head = await git(root, ["rev-parse", "HEAD"]);
  await assertAttributionFree("chore: fix readme wording", base, head, root, policyDir);
});

test("blocks widened model names in trailers and identities, but allows them in prose", async (context) => {
  const { root, base, human } = await fixture(context);
  const prose = await commit(
    root,
    "chore: clarify setup\n\n使用 DeepSeek 编写的说明已经维护者复核",
    human
  );
  await assertAttributionFree("chore: clarify setup", base, prose, root, policyDir);
  const trailer = await commit(
    root,
    "chore: clarify setup\n\n澄清安装步骤。\n\nAssisted-by: Qwen",
    human
  );
  await assert.rejects(
    assertAttributionFree("chore: clarify setup", base, trailer, root, policyDir),
    /trailer Assisted-by names an AI agent or model: Qwen/
  );
  const grok = await commit(root, "chore: clarify setup", {
    name: "Grok Ng",
    email: "g@example.com",
  });
  await assert.rejects(
    assertAttributionFree("chore: clarify setup", base, grok, root, policyDir),
    /names an AI agent or model: Grok/
  );
});

test("keeps the repository's own AI feature names allowed", async (context) => {
  const { root, base, human } = await fixture(context);
  const head = await commit(
    root,
    "feat: add AI Review and AI Gateway routing\n\nAI Review 步骤读取 AI Gateway 配置。",
    human
  );
  await assertAttributionFree(
    "feat: add AI Review and AI Gateway routing",
    base,
    head,
    root,
    policyDir
  );
});

test("fails closed when the attribution policy is missing", async (context) => {
  const { root, base, human } = await fixture(context);
  const head = await commit(root, "chore: clarify setup", human);
  const emptyPolicy = await mkdtemp(join(tmpdir(), "attribution-policy-"));
  context.after(() => rm(emptyPolicy, { recursive: true, force: true }));
  await assert.rejects(
    assertAttributionFree("chore: clarify setup", base, head, root, emptyPolicy)
  );
});

test("ordinary PR commit history enforces the same message rules as preflight", async (context) => {
  const { root, base, human } = await fixture(context);
  const head = await commit(root, "fix: reject invalid token", human);
  await assert.rejects(
    assertAttributionFree("fix: reject invalid token", base, head, root, policyDir),
    /requires a blank line and a Chinese explanatory body/
  );
  await assertAttributionFree("fix: reject invalid token", base, head, root, policyDir, true);
  const next = await commit(root, "fix: reject invalid token\n\nReject invalid token.", human);
  await assert.rejects(
    assertAttributionFree("fix: reject invalid token", base, next, root, policyDir, true),
    /body must contain Chinese text/
  );
});

test("commit preflight requires an English title, blank line and Chinese explanation", () => {
  for (const message of [
    "fix(auth): reject invalid token\n\n拒绝无效令牌，避免认证绕过。",
    "chore: update dependencies\r\n\r\n统一依赖版本。\r\n",
  ]) {
    assert.doesNotThrow(() => validateCommitMessage(message));
  }
  for (const message of [
    "fix: reject invalid token",
    "fix: reject invalid token\n\n   ",
    "fix: reject invalid token\n拒绝无效令牌。",
    "fix: reject invalid token\n\nReject invalid token.",
    "fix: reject invalid token\n\nCo-Authored-By: 张三",
    "docs: update instructions\n\n更新说明。",
    "fix: 修复认证\n\n拒绝无效令牌。",
  ]) {
    assert.throws(() => validateCommitMessage(message));
  }
});
