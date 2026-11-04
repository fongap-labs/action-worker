import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parse } from "yaml";

type Step = {
  name?: string;
  id?: string;
  uses?: string;
  env?: Record<string, string>;
  with?: Record<string, string>;
};

type Job = { steps: Step[] };

test("dependency repair isolates reads, publishing and sandbox source checkout", async () => {
  const source = await readFile(".github/workflows/dependency-repair-dispatch.yml", "utf8");
  const workflow = parse(source) as { jobs: Record<string, Job> };
  const inJob = (job: string, name: string) => {
    const found = workflow.jobs[job]?.steps.find((step) => step.name === name);
    assert.ok(found, `Missing ${job} / ${name}`);
    return found;
  };

  assert.doesNotMatch(source, /secrets\.AW_CONTROL_TOKEN/);
  const prepare = inJob("prepare", "Mint dependency repair read token");
  assert.equal(prepare.with?.["permission-contents"], "read");
  assert.equal(prepare.with?.["permission-pull-requests"], "read");
  assert.equal(
    inJob("prepare", "Resolve dependency repair").env?.AW_CONTROL_TOKEN,
    "${{ steps.prepare_read_app.outputs.token }}"
  );

  // Untrusted dependency computation cannot mint an App token or access a writer.
  const compute = workflow.jobs.compute?.steps ?? [];
  assert.equal(
    compute.some((step) => step.uses?.includes("mint-app-token")),
    false
  );
  assert.equal(
    inJob("compute", "Checkout private target source").with?.token,
    "${{ secrets.AW_CHECKOUT_TOKEN }}"
  );

  const pubRead = inJob("publish", "Mint dependency repair publish read token");
  const pubPush = inJob("publish", "Mint dependency repair publish push token");
  assert.equal(pubRead.with?.["permission-contents"], "read");
  assert.equal(pubRead.with?.["permission-pull-requests"], "read");
  assert.equal(pubPush.with?.["permission-contents"], "write");
  assert.equal(pubPush.with?.["permission-pull-requests"], undefined);
  assert.equal(
    inJob("publish", "Checkout target branch").with?.token,
    "${{ steps.publish_read_app.outputs.token }}"
  );
  const publish = inJob("publish", "Revalidate and publish generated outputs");
  assert.equal(publish.env?.AW_CONTROL_TOKEN, "${{ steps.publish_read_app.outputs.token }}");
  assert.equal(
    publish.env?.AW_REPAIR_PUSH_API_TOKEN,
    "${{ steps.publish_push_app.outputs.token }}"
  );

  assert.equal(
    inJob("finalize", "Publish repair status and continue intake").env?.AW_CONTROL_TOKEN,
    "${{ steps.final_read_app.outputs.token }}"
  );
  assert.equal(
    inJob("finalize", "Mint dependency repair final PR read token").with?.[
      "permission-pull-requests"
    ],
    "read"
  );
});

test("dependency repair never uses the read credential to push generated changes", async () => {
  const script = await readFile("scripts/publish-dependency-repair.ts", "utf8");
  assert.match(script, /AW_REPAIR_PUSH_API_TOKEN/);
  assert.match(script, /gitPushEnvironment\(pushToken\)/);
  assert.doesNotMatch(script, /gitPushEnvironment\(token\)/);
  assert.match(script, /no control PAT fallback is permitted/);
});
