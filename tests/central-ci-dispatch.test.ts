import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const workflow = readFileSync(".github/workflows/central-ci-dispatch.yml", "utf8");
const sandbox = readFileSync(".github/workflows/central-ci-sandbox.yml", "utf8");

test("main CI dispatches do not cancel the same immutable head", () => {
  assert.match(
    workflow,
    /cancel-in-progress: \$\{\{ github\.event\.action == 'run-central-ci' \}\}/
  );
});

test("main CI reuses successful evidence before heavy jobs", () => {
  assert.match(workflow, /select\(\.context == "CI Evidence"\)/);
  assert.match(workflow, /context=CI Evidence/);
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
  assert.match(sandbox, /token: \$\{\{ secrets\.checkout_token \|\| github\.token \}\}/);
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
