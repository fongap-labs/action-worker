import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { dispatcherRunsOn } from "../scripts/resolve-dispatcher-runs-on.ts";
import { parseRunnerPolicy } from "../scripts/runner-policy.ts";
import { workflowContentHash } from "../scripts/validate-security.ts";

const templateFile = "templates/pr-dispatcher/dispatch-pr-governance.yml";

test("the approved dispatcher hash in the security policy matches the template", async () => {
  const template = await readFile(templateFile, "utf8");
  const policy = JSON.parse(await readFile("policies/security.json", "utf8")) as {
    approved_workflows: Array<{ path: string; sha256: string }>;
  };
  assert.deepEqual(policy.approved_workflows, [
    { path: ".github/workflows/dispatch-pr-governance.yml", sha256: workflowContentHash(template) },
  ]);
});

test("the dispatcher template names no runner, checks out nothing and runs no pull request code", async () => {
  const template = await readFile(templateFile, "utf8");
  assert.match(
    template,
    /runs-on: \$\{\{ fromJSON\(vars\.AW_DISPATCH_RUNS_ON \|\| '"ubuntu-24\.04"'\) \}\}/
  );
  assert.equal(/self-hosted/.test(template.replace(/^\s*#.*$/gm, "")), false);
  assert.equal(/^\s*-?\s*uses:/m.test(template), false);
  assert.match(template, /types: \[opened, synchronize\]/);
  assert.match(template, /dependabot\[bot\]/);
});

test("the dispatcher runner comes from central policy and never leaves the control domain", async () => {
  const base = JSON.parse(await readFile("policies/runner.json", "utf8")) as {
    profiles: Record<string, { enabled: boolean }>;
  };
  const hosted = parseRunnerPolicy(base);
  assert.equal(dispatcherRunsOn(hosted, "control-standard"), '"ubuntu-24.04"');
  // Disabled self-hosted profile falls back to an equivalent control profile.
  assert.equal(dispatcherRunsOn(hosted, "control-self-hosted"), '"ubuntu-24.04"');

  const selfHosted = parseRunnerPolicy({
    ...base,
    profiles: {
      ...base.profiles,
      "control-self-hosted": { ...base.profiles["control-self-hosted"], enabled: true },
    },
  });
  assert.equal(
    dispatcherRunsOn(selfHosted, "control-self-hosted"),
    '["self-hosted","linux","aw-control"]'
  );

  assert.throws(() => dispatcherRunsOn(hosted, "linux-standard"), /control-domain/);
  assert.throws(() => dispatcherRunsOn(hosted, "production-deploy"), /control-domain/);
});
