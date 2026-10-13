import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { runText } from "../scripts/runtime-command.ts";
import { assertAttributionFree } from "../scripts/validate-change-record.ts";

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
  const head = await commit(root, "docs: clarify setup", human);
  await assertAttributionFree("docs: clarify setup", base, head, root, policyDir);
});

test("rejects a commit whose author is an AI agent", async (context) => {
  const { root, base, human } = await fixture(context);
  const head = await commit(root, "docs: clarify setup", claude, human);
  await assert.rejects(
    assertAttributionFree("docs: clarify setup", base, head, root, policyDir),
    /author or committer names an AI agent or model: Claude/
  );
});

test("rejects a commit whose committer is an AI agent", async (context) => {
  const { root, base, human } = await fixture(context);
  const head = await commit(root, "docs: clarify setup", human, claude);
  await assert.rejects(
    assertAttributionFree("docs: clarify setup", base, head, root, policyDir),
    /author or committer names an AI agent or model: Claude/
  );
});

test("rejects an AI agent identity that appears only in the email address", async (context) => {
  const { root, base } = await fixture(context);
  const head = await commit(root, "docs: clarify setup", {
    name: "Ada",
    email: "noreply@anthropic.com",
  });
  await assert.rejects(
    assertAttributionFree("docs: clarify setup", base, head, root, policyDir),
    /author or committer names an AI agent or model: anthropic/
  );
});

test("rejects a Co-Authored-By trailer that names an AI agent", async (context) => {
  const { root, base, human } = await fixture(context);
  const head = await commit(
    root,
    "docs: clarify setup\n\nCo-Authored-By: Claude <noreply@anthropic.com>",
    human
  );
  await assert.rejects(
    assertAttributionFree("docs: clarify setup", base, head, root, policyDir),
    /commit .* message names an AI agent or model/
  );
});

test("rejects generated-with and assisted-by attribution lines", async (context) => {
  const { root, base, human } = await fixture(context);
  const generated = await commit(root, "docs: clarify setup\n\nGenerated with [Tool]", human);
  await assert.rejects(
    assertAttributionFree("docs: clarify setup", base, generated, root, policyDir),
    /Generated with/
  );
  const robot = await commit(root, "docs: clarify setup\n\n🤖 drafted", human);
  await assert.rejects(
    assertAttributionFree("docs: clarify setup", base, robot, root, policyDir),
    /🤖/
  );
});

test("accepts commits and titles that only name the CLAUDE.md and AGENTS.md files", async (context) => {
  const { root, base, human } = await fixture(context);
  const head = await commit(root, "docs: link CLAUDE.md and AGENTS.md from README", human);
  await assertAttributionFree(
    "docs: link CLAUDE.md and AGENTS.md from README",
    base,
    head,
    root,
    policyDir
  );
});

test("identity-only words are checked in identities but not in commit messages", async (context) => {
  const { root, base, human } = await fixture(context);
  const message = await commit(root, "fix: keep the cursor position in the editor", human);
  await assertAttributionFree(
    "fix: keep the cursor position in the editor",
    base,
    message,
    root,
    policyDir
  );
  const identity = await commit(root, "docs: clarify setup", {
    name: "Devin Lee",
    email: "devin@example.com",
  });
  await assert.rejects(
    assertAttributionFree("docs: clarify setup", base, identity, root, policyDir),
    /names an AI agent or model: Devin/
  );
});

test("rejects an AI name in the PR title", async (context) => {
  const { root, base, human } = await fixture(context);
  const head = await commit(root, "feat: add support", human);
  await assert.rejects(
    assertAttributionFree("feat: add Claude support", base, head, root, policyDir),
    /PR title names an AI agent or model: Claude/
  );
  await assertAttributionFree("docs: link CLAUDE.md", base, head, root, policyDir);
});

test("skips merge commits whose subject names the merged branch", async (context) => {
  const { root, base, human } = await fixture(context);
  await git(root, ["switch", "-q", "-c", "claude/fix-readme"], identityEnv(human));
  await commit(root, "docs: fix readme wording", human);
  await git(root, ["switch", "-q", "-"], identityEnv(human));
  await git(
    root,
    ["merge", "-q", "--no-ff", "claude/fix-readme", "-m", "Merge branch 'claude/fix-readme'"],
    identityEnv(human)
  );
  const head = await git(root, ["rev-parse", "HEAD"]);
  await assertAttributionFree("docs: fix readme wording", base, head, root, policyDir);
});

test("fails closed when the attribution policy is missing", async (context) => {
  const { root, base, human } = await fixture(context);
  const head = await commit(root, "docs: clarify setup", human);
  const emptyPolicy = await mkdtemp(join(tmpdir(), "attribution-policy-"));
  context.after(() => rm(emptyPolicy, { recursive: true, force: true }));
  await assert.rejects(assertAttributionFree("docs: clarify setup", base, head, root, emptyPolicy));
});
