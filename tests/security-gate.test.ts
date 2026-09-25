import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { collectSecurityViolations } from "../scripts/validate-security.ts";
import { runText } from "../scripts/runtime-command.ts";

const policyPath = resolve("policies/security.json");

async function git(root: string, args: readonly string[]): Promise<string> {
  return await runText("git", args, { cwd: root });
}

async function initRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "action-worker-security-"));
  await git(root, ["init", "-q"]);
  await git(root, ["config", "user.name", "Test"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await writeFile(join(root, "README.md"), "# Fixture\n", "utf8");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-qm", "base"]);
  return root;
}

test("security gate accepts ordinary source changes", async (context) => {
  const root = await initRepo();
  context.after(() => rm(root, { recursive: true, force: true }));
  const base = await git(root, ["rev-parse", "HEAD"]);
  await writeFile(join(root, "README.md"), "# Fixture\n\nSafe change.\n", "utf8");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-qm", "safe"]);
  const head = await git(root, ["rev-parse", "HEAD"]);
  assert.deepEqual(await collectSecurityViolations(root, base, head, policyPath), []);
});

test("security gate rejects added credentials without echoing their value", async (context) => {
  const root = await initRepo();
  context.after(() => rm(root, { recursive: true, force: true }));
  const base = await git(root, ["rev-parse", "HEAD"]);
  const token = "ghp_" + "A".repeat(24);
  await writeFile(join(root, "config.txt"), `TOKEN=${token}\n`, "utf8");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-qm", "credential"]);
  const head = await git(root, ["rev-parse", "HEAD"]);
  const violations = await collectSecurityViolations(root, base, head, policyPath);
  assert.equal(violations.some((item) => item.rule === "github-token" && item.path === "config.txt"), true);
  assert.equal(JSON.stringify(violations).includes(token), false);
});

test("security gate rejects sensitive files and unpinned workflow actions", async (context) => {
  const root = await initRepo();
  context.after(() => rm(root, { recursive: true, force: true }));
  const base = await git(root, ["rev-parse", "HEAD"]);
  await writeFile(join(root, ".env"), "SAFE_PLACEHOLDER=value\n", "utf8");
  await mkdir(join(root, ".github", "workflows"), { recursive: true });
  await writeFile(
    join(root, ".github", "workflows", "ci.yml"),
    "name: CI\non: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@main\n",
    "utf8",
  );
  await git(root, ["add", "."]);
  await git(root, ["commit", "-qm", "unsafe"]);
  const head = await git(root, ["rev-parse", "HEAD"]);
  const violations = await collectSecurityViolations(root, base, head, policyPath);
  assert.equal(violations.some((item) => item.rule === "sensitive-path" && item.path === ".env"), true);
  assert.equal(violations.some((item) => item.rule === "unpinned-action" && item.path === ".github/workflows/ci.yml"), true);
});
