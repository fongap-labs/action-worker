import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";
import { parse } from "yaml";

type Step = { name?: string; uses?: string; with?: Record<string, unknown> };
type Job = { steps?: Step[]; secrets?: unknown; uses?: string };
type Workflow = { jobs: Record<string, Job> };

const workflowDirectory = ".github/workflows";

async function workflowNames(): Promise<string[]> {
  return (await readdir(workflowDirectory)).filter((name) => name.endsWith(".yml")).sort();
}

async function workflow(name: string): Promise<Workflow> {
  return parse(await readFile(`${workflowDirectory}/${name}`, "utf8")) as Workflow;
}

function secretNames(value: unknown): string[] {
  return [...JSON.stringify(value).matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map(
    (match) => match[1] ?? ""
  );
}

function usesWholeSecretsContext(value: unknown): boolean {
  return /\$\{\{\s*(?:toJSON\()?secrets\s*\)?\s*\}\}|secrets:\s*inherit/.test(
    JSON.stringify(value)
  );
}

const centralSecrets = ["AW_CONTROL_TOKEN", "AW_ADMIN_TOKEN", "AW_DISPATCH_TOKEN"];

test("the CI sandbox references no secret except its read-only checkout token", async () => {
  const sandbox = await workflow("central-ci-sandbox.yml");
  assert.deepEqual([...new Set(secretNames(sandbox))], ["checkout_token"]);
  assert.equal(usesWholeSecretsContext(sandbox), false);
});

test("the CI dispatch hands the sandbox only the read-only checkout token", async () => {
  const dispatch = await workflow("central-ci-dispatch.yml");
  const callers = Object.entries(dispatch.jobs).filter(
    ([, job]) => job.uses === "./.github/workflows/central-ci-sandbox.yml"
  );
  assert.ok(callers.length >= 2, "linux and windows both call the sandbox");
  for (const [name, job] of callers) {
    assert.deepEqual(Object.keys(job.secrets as object), ["checkout_token"], name);
    assert.deepEqual(secretNames(job.secrets), ["AW_CHECKOUT_TOKEN"], name);
  }
  const checkout = dispatch.jobs.security?.steps?.find((step) => step.with?.path === "target");
  assert.deepEqual(secretNames(checkout), ["AW_CHECKOUT_TOKEN"]);
});

test("dependency repair computes without any central write credential", async () => {
  const repair = await workflow("dependency-repair-dispatch.yml");
  assert.deepEqual(
    secretNames(repair.jobs.compute).filter((name) => centralSecrets.includes(name)),
    []
  );
  assert.deepEqual([...new Set(secretNames(repair.jobs.compute))], ["AW_CHECKOUT_TOKEN"]);
  assert.equal(usesWholeSecretsContext(repair.jobs.compute), false);
});

test("every checkout drops its credentials", async () => {
  const persisted = new Set<string>([]);
  const found: string[] = [];
  const violations: string[] = [];
  for (const name of await workflowNames()) {
    const parsed = await workflow(name);
    for (const [jobName, job] of Object.entries(parsed.jobs)) {
      for (const step of job.steps ?? []) {
        if (!step.uses?.startsWith("actions/checkout@")) continue;
        const key = `${name}#${jobName}#${step.name ?? ""}`;
        if (step.with?.["persist-credentials"] === false) continue;
        found.push(key);
        if (!persisted.has(key)) violations.push(key);
      }
    }
  }
  assert.deepEqual(violations, []);
  assert.deepEqual(found, [...persisted], "the allowlist has no stale entry");
});

test("the security scan keeps the admin token away from the CodeQL job", async () => {
  const scan = await workflow("security-scan-dispatch.yml");
  for (const [name, job] of Object.entries(scan.jobs)) {
    const usesAdmin = secretNames(job).includes("AW_ADMIN_TOKEN");
    assert.equal(usesAdmin, name === "publish", `${name} AW_ADMIN_TOKEN usage`);
  }
  assert.deepEqual(secretNames(scan.jobs.analyze), []);
  assert.equal(usesWholeSecretsContext(scan.jobs.analyze), false);
  assert.deepEqual(
    scan.jobs.publish?.steps?.filter((step) => step.uses?.includes("codeql")),
    []
  );
});
