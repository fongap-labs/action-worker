import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";
import { parse } from "yaml";

type Workflow = { name?: string; on?: Record<string, unknown> };

const workflowDirectory = ".github/workflows";
const deployPolicyPath = "policies/deploy.json";
const acronyms: Record<string, string> = { ci: "CI", pr: "PR" };
// Workflow file names have at most three kebab-case segments (scripts/validate-naming-rules.ts).
const maxSegments = 3;

// Files that keep a name outside the rule. Each entry says why renaming is not worth it; an entry
// that already follows the rule, or names a missing file, fails the test, so the list stays exact.
const dispatchNameExceptions: Record<string, string> = {
  "handle-pr-dispatch.yml":
    "its path is a CI Evidence trust anchor (scripts/ci-evidence.ts) and a work metrics key",
  "handle-pr-review.yml":
    "the AI Review queue counts runs of this file (scripts/wait-review-turn.ts)",
};

// What a release workflow releases. A new kind is a deliberate edit here and in
// docs/NAMING_CONVENTIONS.md section 8.1, never a repository or product name.
const releaseKinds = ["app", "tool"];

// A workflow that releases or deploys is named by what it does (`release-<kind>.yml`,
// `deploy-<adapter>.yml`), so a person finds it by the work they want done; the dispatch-event rule
// below does not apply to it. Which of them a person may start is decided by its class
// (tests/workflow-classes.test.ts).
const operationPattern = /^(release|deploy)-(.+)\.yml$/;

async function workflows(): Promise<Array<{ file: string; workflow: Workflow }>> {
  const files = (await readdir(workflowDirectory)).filter((file) => file.endsWith(".yml")).sort();
  return Promise.all(
    files.map(async (file) => ({
      file,
      workflow: parse(await readFile(`${workflowDirectory}/${file}`, "utf8")) as Workflow,
    }))
  );
}

function displayName(file: string): string {
  return file
    .replace(/\.yml$/, "")
    .split("-")
    .map((word) => acronyms[word] ?? `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join(" ");
}

// A workflow that is started by repository_dispatch and not by push is a dispatch entry point.
function dispatchEvent(workflow: Workflow): string | undefined {
  const triggers = workflow.on ?? {};
  if (!("repository_dispatch" in triggers) || "push" in triggers) return undefined;
  const dispatch = triggers.repository_dispatch as { types?: unknown } | null;
  const types = Array.isArray(dispatch?.types) ? dispatch.types : [];
  assert.equal(typeof types[0], "string", "a dispatch entry point declares its event types");
  return types[0] as string;
}

// The most complete name that fits: handle-<subject>-dispatch, then <subject>-dispatch, then
// <subject>, where the subject is the event name without its run- prefix.
export function expectedDispatchFile(event: string): string {
  const subject = event.replace(/^run-/, "");
  const candidates = [`handle-${subject}-dispatch`, `${subject}-dispatch`, subject];
  const fitting = candidates.find((name) => name.split("-").length <= maxSegments);
  assert.ok(fitting, `the subject of ${event} has more than ${maxSegments} segments`);
  return `${fitting}.yml`;
}

test("the dispatch file name keeps as much of the rule as three segments allow", () => {
  assert.equal(expectedDispatchFile("run-task"), "handle-task-dispatch.yml");
  assert.equal(expectedDispatchFile("run-security-scan"), "security-scan-dispatch.yml");
  assert.equal(expectedDispatchFile("run-source-script-deploy"), "source-script-deploy.yml");
  assert.equal(expectedDispatchFile("cancel-pr-work"), "cancel-pr-work.yml");
});

test("workflow files are named after the dispatch event they handle", async () => {
  for (const { file, workflow } of await workflows()) {
    if (operationPattern.test(file)) continue;
    const event = dispatchEvent(workflow);
    if (event === undefined) continue;
    const expected = expectedDispatchFile(event);
    if (file in dispatchNameExceptions) {
      assert.notEqual(file, expected, `${file} follows the rule; remove its exception`);
      continue;
    }
    assert.equal(file, expected, `${file} handles ${event}`);
  }
});

test("every workflow display name spells out its file name", async () => {
  for (const { file, workflow } of await workflows()) {
    assert.equal(workflow.name, displayName(file), `display name of ${file}`);
  }
});

test("release and deploy workflows are named by kind", async () => {
  const deploy = JSON.parse(await readFile(deployPolicyPath, "utf8")) as {
    adapters: Record<string, unknown>;
  };
  const operations = (await workflows()).filter(({ file }) => operationPattern.test(file));
  assert.deepEqual(
    operations.map(({ file }) => file),
    ["deploy-source-script.yml", "release-app.yml", "release-tool.yml"]
  );
  for (const { file } of operations) {
    const match = operationPattern.exec(file);
    assert.ok(match, file);
    const [, verb, subject = ""] = match;
    if (verb === "deploy") {
      assert.ok(subject in deploy.adapters, `${file}: ${subject} is not a deploy adapter`);
    } else {
      assert.ok(releaseKinds.includes(subject), `${file}: ${subject} is not a release kind`);
    }
  }
});

test("every naming exception points at an existing workflow", async () => {
  const files = new Set((await workflows()).map(({ file }) => file));
  for (const file of Object.keys(dispatchNameExceptions)) {
    assert.equal(files.has(file), true, `stale naming exception: ${file}`);
  }
});
