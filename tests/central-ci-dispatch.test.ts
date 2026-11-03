import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const workflow = readFileSync(".github/workflows/central-ci-dispatch.yml", "utf8");
const sandbox = readFileSync(".github/workflows/central-ci-sandbox.yml", "utf8");

test("Central CI never cancels an active test for the same head SHA", () => {
  assert.match(
    workflow,
    /group: central-ci-\$\{\{ github\.event\.client_payload\.repository \}\}-\$\{\{ github\.event\.client_payload\.head_sha \}\}/
  );
  assert.match(workflow, /cancel-in-progress: false/);
  assert.doesNotMatch(workflow, /cancel-in-progress: true/);
});

test("main CI reuses successful evidence before heavy jobs", () => {
  assert.match(workflow, /should-run-central-ci\.ts/);
  assert.match(workflow, /"CI Evidence"/);
  assert.doesNotMatch(workflow, /ci-evidence/);
  assert.match(
    workflow,
    /should_run: \$\{\{ steps\.ref_facts\.outputs\.should_run \|\| 'true' \}\}/
  );
  assert.match(
    workflow,
    /Central CI \/ Linux[\s\S]*?if: needs\.prepare\.outputs\.should_run != 'false'/
  );
  assert.match(
    workflow,
    /Central CI \/ Security[\s\S]*?if: needs\.prepare\.outputs\.should_run != 'false'/
  );
  assert.match(
    workflow,
    /Publish Central CI[\s\S]*?needs\.prepare\.outputs\.should_run != 'false'/
  );
});

test("Linux CI fans out over the shards resolved from the trusted manifest", () => {
  assert.match(workflow, /linux_shards: \$\{\{ steps\.capabilities\.outputs\.linux_shards \}\}/);
  assert.match(
    workflow,
    /Central CI \/ Linux \(\$\{\{ matrix\.shard \}\}\)[\s\S]*?fail-fast: true[\s\S]*?shard: \$\{\{ fromJSON\(needs\.prepare\.outputs\.linux_shards \|\| '\["all"\]'\) \}\}/
  );
  assert.match(workflow, /shard: \$\{\{ matrix\.shard \}\}/);
  assert.match(sandbox, /CENTRAL_CI_SHARD: \$\{\{ inputs\.shard \}\}/);
});

test("an unsharded project keeps the exact single-argument script invocation", () => {
  assert.match(sandbox, /script_args=\("\$GITHUB_WORKSPACE\/target"\)/);
  assert.match(
    sandbox,
    /if \[ "\$CENTRAL_CI_SHARD" != "all" \]; then\n\s+script_args\+=\("\$CENTRAL_CI_SHARD"\)/
  );
  assert.match(sandbox, /bash "\$script" "\$\{script_args\[@\]\}" >"\$log" 2>&1/);
});

test("finalization waits for every Linux shard", () => {
  assert.match(workflow, /LINUX_RESULT: \$\{\{ needs\.linux\.result \}\}/);
  assert.match(workflow, /\[\[ "\$LINUX_RESULT" == "success" \]\]/);
});

test("jobs that execute change code reference no central credential", () => {
  // The only secret the sandbox can see is the optional checkout token its caller passes.
  assert.deepEqual([...new Set(sandbox.match(/secrets\.[A-Za-z_]+/g))], ["secrets.checkout_token"]);
  assert.match(sandbox, /token: \$\{\{ secrets\.checkout_token \}\}/);
  assert.match(sandbox, /token: \$\{\{ github\.token \}\}/);
  assert.doesNotMatch(sandbox, /secrets\.checkout_token \|\| github\.token/);
  assert.match(sandbox, /workflow_call:/);
  const privateOnlyToken =
    "checkout_token: ${{ needs.prepare.outputs.is_private == 'true' && secrets.AW_CHECKOUT_TOKEN || '' }}";
  for (const job of ["linux", "windows"]) {
    const start = workflow.indexOf(`\n  ${job}:\n`);
    assert.notEqual(start, -1, `missing ${job} job`);
    const next = workflow.slice(start + 1).search(/\n {2}[a-z]+:\n/);
    const body = workflow.slice(start, next === -1 ? undefined : start + 1 + next);
    assert.match(body, /uses: \.\/\.github\/workflows\/central-ci-sandbox\.yml/);
    assert.ok(
      body.includes(privateOnlyToken),
      `${job} must pass the token only for private targets`
    );
    assert.doesNotMatch(body, /\n\s+steps:/);
  }
});

test("central CI re-checks PR trust before resolving what to execute", () => {
  assert.match(
    workflow,
    /- name: Enforce PR trust\n\s+if: github\.event\.action == 'run-central-ci'[\s\S]*?node scripts\/pr-trust\.ts "\$REPOSITORY" "\$PR_NUMBER" "\$EXPECTED_HEAD_SHA"[\s\S]*?- name: Resolve PR CI control/
  );
});

test("CI follow-ups are dispatched independently when Windows is skipped", () => {
  const windows = workflow.slice(
    workflow.indexOf("\n  windows:\n"),
    workflow.indexOf("  finalize:")
  );
  assert.match(windows, /has_windows == 'true'/, "the windows job is conditional");
  const finalize = workflow.slice(
    workflow.indexOf("  finalize:"),
    workflow.indexOf("  prepare-failure:")
  );
  assert.match(finalize, /Dispatch asynchronous CI follow-ups/);
  assert.match(finalize, /run-ci-follow-up/);
  assert.match(finalize, /if: success\(\)/);
});

test("a pull request CI that fails in prepare still publishes a CI Evidence verdict", () => {
  const job = workflow.slice(workflow.indexOf("  prepare-failure:"), workflow.length);
  assert.match(
    job,
    /if: always\(\) && needs\.prepare\.result == 'failure' && github\.event\.action == 'run-central-ci'/
  );
  assert.match(job, /permissions: \{\}/);
  assert.match(job, /\[ "\$current_head" != "\$REQUESTED_HEAD_SHA" \]/);
  assert.match(job, /write-commit-status\.ts "\$REPOSITORY" "\$REQUESTED_HEAD_SHA" failure/);
  assert.match(job, /"CI Evidence"/);
  assert.doesNotMatch(job, /central-ci\.sh/);
});

test("a pull request is tested at a pinned merge SHA, not at a mutable merge ref", () => {
  const checkoutTemplate =
    "ref: ${{ inputs.pr_number != '0' && inputs.merge_sha || inputs.head_sha }}";
  // Four target checkouts: private and public variants on both Linux and Windows.
  assert.equal(sandbox.split(checkoutTemplate).length, 5);
  assert.doesNotMatch(sandbox, /format\('refs\/pull\/\{0\}\/merge'/);
  assert.doesNotMatch(sandbox, /ref: \$\{\{ inputs\.head_sha \}\}/);
  assert.match(workflow, /merge_sha: \$\{\{ steps\.merge_ref\.outputs\.merge_sha/);
  assert.equal(
    workflow.split("merge_sha: ${{ needs.prepare.outputs.merge_sha }}").length,
    3,
    "Linux and Windows receive the same prepared merge commit"
  );
  assert.match(sandbox, /node aw\/scripts\/verify-ci-checkout\.ts/);
  assert.doesNotMatch(
    sandbox,
    /run: node aw\/scripts\/verify-ci-checkout\.ts[^\n]*\$\{\{ inputs\./
  );

  // The secret scan and status verdicts still use the original PR head.
  const security = workflow.slice(
    workflow.indexOf("  security:\n"),
    workflow.indexOf("\n  windows:\n")
  );
  assert.match(security, /ref: \$\{\{ needs\.prepare\.outputs\.head_sha \}\}/);
});

test("main CI transfers intake's short lease to the active Central CI run before expensive jobs", () => {
  const prepareSection = workflow.slice(
    workflow.indexOf("  prepare:\n"),
    workflow.indexOf("\n  linux:\n")
  );
  assert.match(prepareSection, /Attach Main CI lease to active Central CI run/);
  assert.match(
    prepareSection,
    /if: github\.event\.action == 'run-central-ci-ref' && steps\.ref_facts\.outputs\.should_run == 'true'/
  );
  assert.match(prepareSection, /AW_STATUS_TOKEN: \$\{\{ secrets\.AW_STATUS_TOKEN \}\}/);
  assert.match(prepareSection, /write-commit-status\.ts "\$REPOSITORY" "\$HEAD_SHA"/);
  assert.match(prepareSection, /"CI Evidence"/);
  assert.match(prepareSection, /"\$RUN_URL"/);
  assert.match(prepareSection, /AW_STATUS_TOKEN/);
  assert.doesNotMatch(prepareSection, /AW_STATUS_TOKEN \|\|/);
});
