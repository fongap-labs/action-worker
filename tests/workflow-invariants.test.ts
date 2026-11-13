import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";
import { parse } from "yaml";

type Step = {
  name?: string;
  id?: string;
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

test("all main CI intake entry points use separate App API and signing credentials", async () => {
  const found: string[] = [];
  for (const name of await workflowNames()) {
    const parsed = await workflow(name);
    for (const [jobName, job] of Object.entries(parsed.jobs)) {
      for (const [index, step] of (job.steps ?? []).entries()) {
        if (!step.run?.includes("scripts/intake-main-ci.ts")) continue;
        const key = `${name}#${jobName}#${step.name ?? ""}`;
        found.push(key);
        const statusToken = String(step.env?.AW_STATUS_API_TOKEN ?? "");
        const dispatchToken = String(step.env?.AW_DISPATCH_API_TOKEN ?? "");
        const statusStepId = /^\$\{\{ steps\.([a-z_]+)\.outputs\.token \}\}$/.exec(
          statusToken
        )?.[1];
        const dispatchStepId = /^\$\{\{ steps\.([a-z_]+)\.outputs\.token \}\}$/.exec(
          dispatchToken
        )?.[1];
        assert.ok(statusStepId, `${key} must forward a scoped App status token`);
        assert.ok(dispatchStepId, `${key} must forward a scoped App dispatch token`);
        const priorSteps = (job.steps ?? []).slice(0, index);
        const statusMint = priorSteps.find((candidate) => candidate.id === statusStepId);
        const dispatchMint = priorSteps.find((candidate) => candidate.id === dispatchStepId);
        assert.equal(statusMint?.uses, "./.github/actions/mint-app-token", `${key} status mint`);
        assert.equal(statusMint?.with?.["permission-statuses"], "write", `${key} status scope`);
        assert.equal(
          dispatchMint?.uses,
          "./.github/actions/mint-app-token",
          `${key} dispatch mint`
        );
        assert.equal(dispatchMint?.with?.["permission-contents"], "write", `${key} dispatch scope`);
        assert.equal(step.env?.AW_STATUS_KEYRING, "${{ secrets.AW_STATUS_KEYRING }}", key);
        assert.equal(
          step.env?.AW_DISPATCH_API_TOKEN,
          `\${{ steps.${dispatchStepId}.outputs.token }}`,
          key
        );
      }
    }
  }
  assert.deepEqual(
    found.sort(),
    [
      "deploy-source-script.yml#prepare#Request central CI for the source",
      "intake.yml#main-ci#Reconcile main CI",
      "release-app.yml#prepare#Request central CI for the source",
      "task-source-dispatch.yml#dispatch#Request central CI for the source",
    ].sort()
  );
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
  assert.deepEqual(secretNames(checkout), []);
  assert.equal(checkout?.with?.token, "${{ steps.security_read_app.outputs.token }}");
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

test("the security scan keeps SARIF publish credentials away from the CodeQL job", async () => {
  const scan = await workflow("security-scan-dispatch.yml");
  for (const [name, job] of Object.entries(scan.jobs)) {
    const hasSarifWriter = job.steps?.some(
      (step) => step.env?.AW_SECURITY_EVENTS_API_TOKEN === "${{ steps.sarif_app.outputs.token }}"
    );
    assert.equal(Boolean(hasSarifWriter), name === "publish", `${name} SARIF writer use`);
  }
  assert.deepEqual(secretNames(scan.jobs.analyze), []);
  assert.equal(secretNames(scan.jobs.publish).includes("AW_ADMIN_TOKEN"), false);
  assert.equal(usesWholeSecretsContext(scan.jobs.analyze), false);
  assert.deepEqual(
    scan.jobs.publish?.steps?.filter((step) => step.uses?.includes("codeql")),
    []
  );
});

test("automatic npm publication runs before the formal tag only for stable dsh-plugin releases", async () => {
  const workflowSource = await readFile(".github/workflows/handle-release-dispatch.yml", "utf8");
  const release = await workflow("handle-release-dispatch.yml");
  const source = await readFile("scripts/publish-release.ts", "utf8");
  const gate = await readFile("scripts/release-npm-gate.ts", "utf8");
  const target = await readFile("scripts/resolve-release-target.ts", "utf8");
  assert.deepEqual(Object.keys(release.jobs), ["release"]);
  const publish = release.jobs.release?.steps?.find(
    (step) => step.name === "Publish governed release"
  );
  assert.equal(publish?.run, "node scripts/publish-release.ts");
  assert.equal(
    publish?.env?.AW_NPM_TOKEN,
    "${{ steps.release_target.outputs.npm_required == 'true' && secrets.AW_NPM_TOKEN || '' }}"
  );
  assert.match(target, /isStableNpmRelease\(/);
  assert.ok(target.includes('source === "fongap-labs/dsh-plugin"'));
  assert.match(gate, /if \(isPrerelease \|\| version.includes\("-"\)\) return null/);
  assert.match(source, /await publishNpmBeforeTag\(/);
  assert.ok(
    source.indexOf("await publishNpmBeforeTag(") < source.indexOf("isPublishAttempted = true;")
  );
  assert.doesNotMatch(workflowSource, /run-npm-republish|workflow_dispatch/);
  assert.match(source, /is_prerelease=\$\{isPrerelease/);
});

test("production releases remain read-only until an approved two-phase staging opt-in", async () => {
  const releaseWorkflow = await workflow("handle-release-dispatch.yml");
  const workflowSource = await readFile(".github/workflows/handle-release-dispatch.yml", "utf8");
  const source = await readFile("scripts/publish-release.ts", "utf8");
  const notes = await readFile("scripts/changelog-release-notes.ts", "utf8");
  const policy = JSON.parse(await readFile("policies/release-two-phase-staging.json", "utf8")) as {
    approved_staging_repositories: unknown;
  };
  assert.deepEqual(Object.keys(releaseWorkflow.jobs).sort(), ["release"]);
  assert.deepEqual(policy.approved_staging_repositories, []);
  assert.doesNotMatch(
    workflowSource,
    /AW_RELEASE_TWO_PHASE_MODE|AW_RELEASE_PR_WRITE_API_TOKEN|AW_RELEASE_PR_STATUS_API_TOKEN|permission-pull-requests:\s*write/
  );
  assert.match(source, /selectReleasePhase\(/);
  assert.match(source, /phase\.kind === "staging"/);
  assert.match(source, /await publishChangelogRelease\(/);
  assert.match(source, /releaseSha = staged\.mergeSha/);
  assert.match(source, /let releaseSha = targetSha/);
  assert.match(source, /prepareReleaseNotes/);
  assert.doesNotMatch(notes, /repos\/\$\{repository\}\/pulls|--method.*(?:POST|PATCH|PUT)/);
});

test("manual source deploy resolves default HEAD without spending the control PAT REST quota", async () => {
  const deploy = await workflow("deploy-source-script.yml");
  const step = deploy.jobs.prepare?.steps?.find(
    (item) => item.name === "Resolve manual deploy request"
  );
  assert.ok(step, "manual deploy resolver must exist");
  assert.equal(step.env?.AW_DEPLOY_SOURCE_READ_TOKEN, "${{ steps.app_read.outputs.token }}");
  assert.equal(step.env?.AW_REPOSITORY_POLICY, undefined);
  assert.match(step.run ?? "", /repository-policy\.ts validate/);
  assert.match(step.run ?? "", /git ls-remote --exit-code/);
  assert.match(step.run ?? "", /GIT_CONFIG_KEY_0=http\.https:\/\/github\.com\/\.extraheader/);
  assert.match(step.run ?? "", /GIT_TERMINAL_PROMPT=0/);
  assert.match(step.run ?? "", /Missing scoped GitHub App read token/);
  assert.match(step.run ?? "", /source_sha=\$SOURCE_SHA/);
  assert.doesNotMatch(step.run ?? "", /gh api|secrets\.AW_CONTROL_TOKEN/);
});

test("manual release and deploy cannot bypass unresolved main-write incidents", async () => {
  for (const name of ["release-app.yml", "deploy-source-script.yml"]) {
    const source = await readFile(`.github/workflows/${name}`, "utf8");
    const pipeline = await workflow(name);
    const auditStep = pipeline.jobs.prepare?.steps?.find(
      (step) => step.name === "Attest the source main write"
    );
    assert.ok(auditStep, `${name} must perform Main Write Audit before validation`);
    assert.equal(
      (auditStep as Step & { "continue-on-error"?: boolean })["continue-on-error"],
      undefined,
      `${name} cannot ignore a failed main-write attestation`
    );
    assert.doesNotMatch(source, /main_write_guard_bypass|MAIN_WRITE_GUARD_BYPASS/);
  }
  for (const name of [
    "scripts/audit-main-writes.ts",
    "scripts/main-write-guard.ts",
    "scripts/changelog-release-pr.ts",
    "scripts/publish-release.ts",
    "scripts/validate-deploy-source.ts",
    "scripts/validate-task-source.ts",
  ]) {
    const code = await readFile(name, "utf8");
    assert.doesNotMatch(
      code,
      /isIncidentBypassEnabled|bypassIncidents|MAIN_WRITE_GUARD_BYPASS/,
      name
    );
    if (name.endsWith("audit-main-writes.ts") || name.endsWith("main-write-guard.ts")) {
      assert.match(code, /await assertNoOpenMainWriteIncidents\(reader, repository\)/, name);
    }
  }
});

test("automatic control PR merge atomically pins the validated head SHA", async () => {
  const config = await workflow("validate-ci.yml");
  const merge = config.jobs["automatic-squash-merge"]?.steps?.find(
    (step) => step.name === "Merge the exact validated PR head"
  );
  assert.ok(merge?.run, "the automatic merge step must be present");
  assert.match(merge.run, /gh api --method PUT "repos\/\$REPOSITORY\/pulls\/\$PR_NUMBER\/merge"/);
  assert.match(merge.run, /--arg sha "\$HEAD_SHA"/);
  assert.match(merge.run, /merge_method:"squash"/);
  assert.match(merge.run, /\.head\.sha == \$head and \.merge_commit_sha == \$merged/);
  assert.doesNotMatch(merge.run, /gh pr merge/);
});
