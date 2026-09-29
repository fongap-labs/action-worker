import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const workflow = readFileSync(".github/workflows/central-ci-dispatch.yml", "utf8");

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
  assert.match(workflow, /CENTRAL_CI_SHARD: \$\{\{ matrix\.shard \}\}/);
});

test("an unsharded project keeps the exact single-argument script invocation", () => {
  assert.match(workflow, /script_args=\("\$GITHUB_WORKSPACE\/target"\)/);
  assert.match(
    workflow,
    /if \[ "\$CENTRAL_CI_SHARD" != "all" \]; then\n\s+script_args\+=\("\$CENTRAL_CI_SHARD"\)/
  );
  assert.match(workflow, /bash "\$script" "\$\{script_args\[@\]\}" >"\$log" 2>&1/);
});

test("finalization waits for every Linux shard", () => {
  assert.match(workflow, /LINUX_RESULT: \$\{\{ needs\.linux\.result \}\}/);
  assert.match(workflow, /\[\[ "\$LINUX_RESULT" == "success" \]\]/);
});
