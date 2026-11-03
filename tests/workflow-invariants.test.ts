import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";
import { parse } from "yaml";

type Step = {
  name?: string;
  uses?: string;
  run?: string;
  env?: Record<string, unknown>;
  with?: Record<string, unknown>;
};
type Job = {
  needs?: string | string[];
  permissions?: Record<string, unknown>;
  steps?: Step[];
  secrets?: unknown;
  uses?: string;
  if?: string;
  concurrency?: Record<string, unknown>;
};
type Workflow = { jobs: Record<string, Job>; concurrency?: Record<string, unknown> };

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

test("all main CI intake entry points forward the dedicated status secret", async () => {
  const found: string[] = [];
  for (const name of await workflowNames()) {
    const parsed = await workflow(name);
    for (const [jobName, job] of Object.entries(parsed.jobs)) {
      for (const step of job.steps ?? []) {
        if (!step.run?.includes("scripts/intake-main-ci.ts")) continue;
        const key = `${name}#${jobName}#${step.name ?? ""}`;
        found.push(key);
        assert.equal(
          step.env?.AW_STATUS_TOKEN,
          "${{ secrets.AW_STATUS_TOKEN }}",
          `${key} must forward AW_STATUS_TOKEN without fallback`
        );
      }
    }
  }
  assert.deepEqual(found.sort(), [
    "intake.yml#main-ci#Reconcile main CI",
    "release-app.yml#prepare#Request central CI for the source",
  ].sort());
});

test("PR dispatch supersedes obsolete governance revisions", async () => {
  const dispatch = await workflow("handle-pr-dispatch.yml");
  assert.equal(
    dispatch.concurrency?.group,
    "pr-governance-${{ github.event.client_payload.repository }}-${{ github.event.client_payload.pr_number }}"
  );
  assert.equal(
    dispatch.concurrency?.["cancel-in-progress"],
    true,
    "a newer PR revision must cancel obsolete governance runs"
  );
  const cancellation = await workflow("cancel-pr-work.yml");
  assert.equal(
    cancellation.jobs.governance?.if,
    "needs.validate.outputs.merged != 'true'",
    "only unmerged closed PRs may cancel active governance"
  );
  assert.equal(cancellation.jobs.governance?.concurrency?.["cancel-in-progress"], true);
  assert.equal(
    cancellation.jobs.governance?.concurrency?.group,
    "pr-governance-${{ needs.validate.outputs.repository }}-${{ needs.validate.outputs.pr_number }}-${{ needs.validate.outputs.head_sha }}"
  );
});

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

test("governed Release dispatches npm only after publication and never publishes inline", async () => {
  const release = await workflow("handle-release-dispatch.yml");
  const npm = await workflow("release-npm.yml");
  const source = await readFile("scripts/publish-release.ts", "utf8");

  assert.equal(release.jobs.npm?.needs, "release");
  assert.equal(
    release.jobs.npm?.if,
    "needs.release.result == 'success' && needs.release.outputs.npm_asset == 'true'"
  );
  assert.equal(release.jobs.npm?.permissions?.contents, "write");
  assert.match(JSON.stringify(release.jobs.npm), /run-npm-republish/);
  assert.match(source, /npm_asset=/);
  assert.doesNotMatch(source, /publishNpmTarball|AW_NPM_TOKEN/);
  assert.match(JSON.stringify(npm), /run-npm-republish/);
  assert.ok(JSON.stringify(npm).includes("republish-release-npm.ts"));
});

test("publishing releases is read-only against source branches and never opens PRs", async () => {
  const releaseWorkflow = await workflow("handle-release-dispatch.yml");
  const source = await readFile("scripts/publish-release.ts", "utf8");
  const notes = await readFile("scripts/changelog-release-notes.ts", "utf8");
  assert.deepEqual(Object.keys(releaseWorkflow.jobs).sort(), ["npm", "release"]);
  assert.doesNotMatch(source, /publishChangelogRelease|openReleasePullRequest|pulls\/[^\n]+merge/);
  assert.match(source, /prepareReleaseNotes/);
  assert.match(source, /const releaseSha = targetSha/);
  assert.doesNotMatch(notes, /repos\/\$\{repository\}\/pulls|--method.*(?:POST|PATCH|PUT)/);
});
