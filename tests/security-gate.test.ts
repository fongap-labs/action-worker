import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { runText } from "../scripts/runtime-command.ts";
import { collectSecurityViolations } from "../scripts/validate-security.ts";

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
  const token = `ghp_${"A".repeat(24)}`;
  await writeFile(join(root, "config.txt"), `TOKEN=${token}\n`, "utf8");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-qm", "credential"]);
  const head = await git(root, ["rev-parse", "HEAD"]);
  const violations = await collectSecurityViolations(root, base, head, policyPath);
  assert.equal(
    violations.some((item) => item.rule === "github-token" && item.path === "config.txt"),
    true
  );
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
    "utf8"
  );
  await git(root, ["add", "."]);
  await git(root, ["commit", "-qm", "unsafe"]);
  const head = await git(root, ["rev-parse", "HEAD"]);
  const violations = await collectSecurityViolations(root, base, head, policyPath);
  assert.equal(
    violations.some((item) => item.rule === "sensitive-path" && item.path === ".env"),
    true
  );
  assert.equal(
    violations.some(
      (item) => item.rule === "unpinned-action" && item.path === ".github/workflows/ci.yml"
    ),
    true
  );
});

const templatePath = resolve("templates/pr-dispatcher/dispatch-pr-governance.yml");
const approvedPath = ".github/workflows/dispatch-pr-governance.yml";

async function commitWorkflow(
  path: string,
  content: string
): Promise<{ root: string; base: string; head: string }> {
  const root = await initRepo();
  const base = await git(root, ["rev-parse", "HEAD"]);
  await mkdir(join(root, ".github", "workflows"), { recursive: true });
  await writeFile(join(root, path), content, "utf8");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-qm", "workflow"]);
  return { root, base, head: await git(root, ["rev-parse", "HEAD"]) };
}

test("security gate exempts only the byte-identical approved pull_request_target dispatcher", async (context) => {
  const { readFile } = await import("node:fs/promises");
  const template = await readFile(templatePath, "utf8");

  const approved = await commitWorkflow(approvedPath, template);
  context.after(() => rm(approved.root, { recursive: true, force: true }));
  assert.deepEqual(
    await collectSecurityViolations(approved.root, approved.base, approved.head, policyPath),
    []
  );

  const crlf = await commitWorkflow(approvedPath, template.replace(/\n/g, "\r\n"));
  context.after(() => rm(crlf.root, { recursive: true, force: true }));
  assert.deepEqual(
    await collectSecurityViolations(crlf.root, crlf.base, crlf.head, policyPath),
    []
  );

  const edited = await commitWorkflow(approvedPath, `${template}# edited\n`);
  context.after(() => rm(edited.root, { recursive: true, force: true }));
  const editedViolations = await collectSecurityViolations(
    edited.root,
    edited.base,
    edited.head,
    policyPath
  );
  assert.equal(
    editedViolations.some((item) => item.rule === "pull-request-target"),
    true
  );

  const elsewhere = await commitWorkflow(".github/workflows/other.yml", template);
  context.after(() => rm(elsewhere.root, { recursive: true, force: true }));
  const elsewhereViolations = await collectSecurityViolations(
    elsewhere.root,
    elsewhere.base,
    elsewhere.head,
    policyPath
  );
  assert.equal(
    elsewhereViolations.some((item) => item.rule === "pull-request-target"),
    true
  );
});
