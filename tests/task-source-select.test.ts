import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

const workflow = readFileSync(".github/workflows/task-source-dispatch.yml", "utf8");

// The step is executed by a runner whose bash provides git and jq, so the tests follow the workflow
// rather than a copy. On Windows a PATH bash may be WSL with a foreign filesystem, and Git Bash
// misses jq, so only a shell that holds both tools may run the step; without one the tests skip.
function detectRunnerBash(): string | null {
  const candidates =
    process.platform === "win32" ? ["C:/Program Files/Git/bin/bash.exe"] : ["bash"];
  for (const bash of candidates) {
    const probe = spawnSync(
      bash,
      ["-c", "command -v git >/dev/null 2>&1 && command -v jq >/dev/null 2>&1"],
      { encoding: "utf8" }
    );
    if (probe.status === 0) return bash;
  }
  return null;
}

// A plain boolean false is the documented no-skip value.
const RUNNER_BASH = detectRunnerBash();
const skipSelect = RUNNER_BASH === null ? "the runner bash with git and jq is unavailable" : false;

// The step's own script, run as the runner runs it, so the test follows the workflow rather than a copy.
function selectProjectsScript(): string {
  const start = workflow.indexOf("- name: Select projects");
  const end = workflow.indexOf("- name: Dispatch selected tasks", start);
  assert.ok(start >= 0 && end > start, "Select projects step not found");
  const block = workflow.slice(start, end);
  const body = block.slice(block.indexOf("run: |\n") + "run: |\n".length);
  return body
    .split("\n")
    .map((line) => line.replace(/^ {10}/, ""))
    .join("\n");
}

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync(
    "git",
    [
      "-c",
      "user.name=test",
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd, encoding: "utf8" }
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function write(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

// Runs the step in a checkout at `target/`: the base commit has one project with a task.json, then
// the head commit applies `changes`. The push range is base..head, as for a push to the source.
function runSelect(changes: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "task-source-select-"));
  try {
    const target = join(root, "target");
    mkdirSync(target);
    git(target, "init", "-q");
    write(target, "projects/Alpha/task.json", "{}");
    git(target, "add", "-A");
    git(target, "commit", "-q", "-m", "base");
    const before = git(target, "rev-parse", "HEAD");

    for (const [path, content] of Object.entries(changes)) write(target, path, content);
    git(target, "add", "-A");
    git(target, "commit", "-q", "-m", "head");
    const head = git(target, "rev-parse", "HEAD");

    const output = join(root, "github_output");
    writeFileSync(output, "");
    const result = spawnSync(RUNNER_BASH as string, ["-c", selectProjectsScript()], {
      cwd: root,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        MODE: "push",
        PROJECT: "",
        BEFORE_SHA: before,
        HEAD_SHA: head,
        GITHUB_OUTPUT: output,
      },
    });
    return {
      status: result.status,
      stderr: result.stderr,
      outputs: readFileSync(output, "utf8").trim(),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("a changed project with a task.json is selected", { skip: skipSelect }, () => {
  const run = runSelect({ "projects/Alpha/task.json": '{"schedule":"daily"}' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.outputs, 'projects=["Alpha"]');
});

test("a changed project without a task.json selects nothing and does not fail the step", {
  skip: skipSelect,
}, () => {
  // The project's name sorts last, so the loop's last test is the one that fails.
  const run = runSelect({ "projects/Zeta/deploy.json": "{}" });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.outputs, "projects=[]");
});

test("a task project is still selected when a deploy-only project sorts after it", {
  skip: skipSelect,
}, () => {
  const run = runSelect({
    "projects/Alpha/task.json": '{"schedule":"daily"}',
    "projects/Zeta/deploy.json": "{}",
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.outputs, 'projects=["Alpha"]');
});
