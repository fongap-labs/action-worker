import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";
import { parse } from "yaml";

type Step = { run?: string };
type Job = { steps?: Step[] };
type Workflow = { jobs?: Record<string, Job> };

const scriptDirectory = "scripts";
const workflowDirectory = ".github/workflows";

async function scriptNames(): Promise<string[]> {
  const files = await readdir(scriptDirectory);
  return files
    .filter((file) => file.endsWith(".ts"))
    .map((file) => file.replace(/\.ts$/, ""))
    .sort();
}

function importedScripts(source: string): string[] {
  return [...source.matchAll(/from "\.\/([a-z0-9-]+)\.ts"/g)].map((match) => match[1] ?? "");
}

// Relative imports reach repository scripts; every other bare specifier is an npm package
// (node: builtins excluded), so a workflow that reaches one of them needs npm ci first.
function importedPackages(source: string): string[] {
  return [...source.matchAll(/(?:from|import) "(@?[a-z][^"]*)"/g)]
    .map((match) => match[1] ?? "")
    .filter((name) => !name.startsWith("node:"));
}

// The set of scripts that transitively import an npm package, including every script that
// imports them: Node resolves the whole static import graph before running any entrypoint,
// so a missing package fails a job even when the entrypoint never calls into the dependency.
async function thirdPartyClosure(): Promise<Set<string>> {
  const sources = new Map<string, string>();
  for (const name of await scriptNames()) {
    sources.set(name, await readFile(`${scriptDirectory}/${name}.ts`, "utf8"));
  }
  const importers = new Map<string, string[]>();
  for (const [name, source] of sources) {
    for (const dependency of importedScripts(source)) {
      importers.set(dependency, [...(importers.get(dependency) ?? []), name]);
    }
  }
  const closure = new Set<string>();
  const queue = [...sources.entries()]
    .filter(([, source]) => importedPackages(source).length > 0)
    .map(([name]) => name);
  while (queue.length > 0) {
    const current = queue.pop() ?? "";
    if (!closure.add(current)) continue;
    for (const importer of importers.get(current) ?? []) {
      if (!closure.has(importer)) queue.push(importer);
    }
  }
  return closure;
}

test("jobs that run scripts depending on npm packages install dependencies first", async () => {
  const closure = await thirdPartyClosure();
  assert.ok(closure.size > 0, "the third-party dependency closure must be discovered");
  const files = (await readdir(workflowDirectory)).filter((file) => file.endsWith(".yml")).sort();
  for (const file of files) {
    const workflow = parse(await readFile(`${workflowDirectory}/${file}`, "utf8")) as Workflow;
    for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
      const steps = job.steps ?? [];
      const reached = new Set<string>();
      for (const step of steps) {
        for (const match of (step.run ?? "").matchAll(
          /node (?:(?:control|aw)\/)?scripts\/([a-z0-9-]+)\.ts/g
        )) {
          reached.add(match[1] ?? "");
        }
      }
      const needing = [...reached].filter((script) => closure.has(script));
      if (needing.length === 0) continue;
      const installs = steps.some((step) => (step.run ?? "").includes("npm ci"));
      assert.equal(
        installs,
        true,
        `${file} job ${jobName} runs ${needing.join(", ")} without an npm ci step`
      );
    }
  }
});
