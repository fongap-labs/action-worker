import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";
import { parse } from "yaml";

type Workflow = { name?: string; on?: Record<string, unknown> };

const workflowDirectory = ".github/workflows";
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

test("every naming exception points at an existing workflow", async () => {
  const files = new Set((await workflows()).map(({ file }) => file));
  for (const file of Object.keys(dispatchNameExceptions)) {
    assert.equal(files.has(file), true, `stale naming exception: ${file}`);
  }
});
