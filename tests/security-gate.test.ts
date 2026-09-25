import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readJson, runText } from "../scripts/runtime-command.ts";
import {
  parseSecurityPolicy,
  validateSecurityRange,
  validateWorkflowText,
} from "../scripts/validate-security.ts";

async function git(root: string, args: readonly string[]): Promise<string> {
  return await runText("git", args, { cwd: root });
}

async function initRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "action-worker-security-"));
  await git(root, ["init", "-q"]);
  await git(root, ["config", "user.name", "Security Test"]);
  await git(root, ["config", "user.email", "security@example.com"]);
  await writeFile(join(root, "README.md"), "# Fixture\n", "utf8");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-qm", "base"]);
  return root;
}

test("security policy rejects leaked token material without relying on AI", async (context) => {
  const root = await initRepo();
  context.after(() => rm(root, { recursive: true, force: true }));
  const base = await git(root, ["rev-parse", "HEAD"]);
  const token = "ghp_" + "A".repeat(32);
  await writeFile(join(root, "README.md"), `# Fixture\n\n${token}\n`, "utf8");
  await git(root, ["add", "README.md"]);
  await git(root, ["commit", "-qm", "leak"]);
  const head = await git(root, ["rev-parse", "HEAD"]);
  const policy = await readJson("policies/security.json");
  const violations = await validateSecurityRange(base, head, root, policy);
  assert.ok(violations.some((item) => item.rule === "github-token" && item.path === "README.md"));
});

test("security policy rejects sensitive files and allows declared templates", async (context) => {
  const root = await initRepo();
  context.after(() => rm(root, { recursive: true, force: true }));
  const base = await git(root, ["rev-parse", "HEAD"]);
  await writeFile(join(root, ".env"), "EXAMPLE=value\n", "utf8");
  await writeFile(join(root, ".env.example"), "EXAMPLE=placeholder\n", "utf8");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-qm", "paths"]);
  const head = await git(root, ["rev-parse", "HEAD"]);
  const policy = await readJson("policies/security.json");
  const violations = await validateSecurityRange(base, head, root, policy);
  assert.ok(violations.some((item) => item.rule === "sensitive-path" && item.path === ".env"));
  assert.equal(violations.some((item) => item.path === ".env.example"), false);
});

test("workflow guards reject risky PR triggers and direct secret interpolation", async () => {
  const policy = parseSecurityPolicy(await readJson("policies/security.json"));
  const content = [
    "name: Unsafe",
    "on:",
    "  pull_request_target:",
    "permissions: write-all",
    "jobs:",
    "  test:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - name: Unsafe",
    "        run: |",
    "          echo \"${{ secrets.EXAMPLE_TOKEN }}\"",
  ].join("\n");
  const violations = validateWorkflowText(".github/workflows/unsafe.yml", content, policy);
  assert.ok(violations.some((item) => item.rule === "workflow-pull-request-target"));
  assert.ok(violations.some((item) => item.rule === "workflow-write-all"));
  assert.ok(violations.some((item) => item.rule === "workflow-direct-secret-in-run"));
});
