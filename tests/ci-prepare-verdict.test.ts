import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";

const central = readFileSync(".github/workflows/central-ci-dispatch.yml", "utf8");
const flow = parse(central) as {
  jobs: Record<
    string,
    { if?: string; steps: Array<{ name?: string; id?: string; if?: string; run?: string }> }
  >;
};
const prepare = flow.jobs["prepare-failure"]!;
assert.ok(prepare);

function getStep(name: string) {
  const item = prepare.steps.find((value) => value.name === name);
  assert.ok(item, "Missing " + name);
  return item;
}

test("main and PR prepare failures both enter a signed fail-closed evidence publisher", () => {
  assert.match(prepare.if ?? "", /run-central-ci-ref/);
  assert.match(prepare.if ?? "", /run-central-ci'/);
  assert.match(prepare.if ?? "", /needs\.prepare\.outputs\.head_sha != ''/);
  const failed = getStep("Publish failed CI Evidence for the current head");
  assert.match(failed.run ?? "", /PR_NUMBER" = "0"/);
  assert.match(failed.run ?? "", /default_branch=/);
  assert.match(failed.run ?? "", /commits\/\$encoded_branch/);
  assert.match(failed.run ?? "", /pulls\/\$PR_NUMBER/);
  assert.match(failed.run ?? "", /"\$current_head" != "\$REQUESTED_HEAD_SHA"/);
  assert.match(failed.run ?? "", /write-commit-status\.ts/);
  assert.match(failed.run ?? "", /"CI Evidence"/);
  assert.match(failed.run ?? "", / failure /);
  assert.doesNotMatch(failed.run ?? "", /"CI Evidence" "Central CI passed"/);
});

test("only failed PR preparation queues PR governance, main uses signed status deduplication", () => {
  for (const name of [
    "Mint prepare failure PR continuation token",
    "Resume PR governance after CI prepare failure",
  ]) {
    assert.match(
      getStep(name).if ?? "",
      /steps\.prepare_publish\.outputs\.published == 'true' && needs\.prepare\.outputs\.pr_number != '0'/
    );
  }
  const main = readFileSync("scripts/should-run-central-ci.ts", "utf8");
  assert.match(main, /hasUnresolvedCiEvidenceFailure/);
  assert.match(main, /decideCiFailureRetry/);
  assert.match(main, /hasStaleCiEvidenceFailure/);
  assert.match(central, /need[s]?\.prepare\.result == 'failure'/);
});
