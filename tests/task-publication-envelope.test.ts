import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";
import { openTaskPublication, sealTaskPublication } from "../scripts/task-publication-envelope.ts";

const identity = {
  repository: "fongap-labs/private-source",
  project: "sensitive-project",
  bootstrap_ref: "a".repeat(40),
};

function keys() {
  const pair = generateKeyPairSync("rsa", {
    modulusLength: 3072,
    publicKeyEncoding: { format: "der", type: "spki" },
    privateKeyEncoding: { format: "pem", type: "pkcs8" },
  });
  return {
    publicKey: pair.publicKey.toString("base64"),
    privateKey: pair.privateKey,
  };
}

test("task publication is confidential across the runner boundary and bound to source identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "aw-publication-test-"));
  try {
    const input = join(root, "staged");
    const opened = join(root, "opened");
    await mkdir(join(input, "payload", "nested"), { recursive: true });
    await writeFile(
      join(input, "manifest.json"),
      JSON.stringify({ target_repository: "fongap-labs/target" })
    );
    await writeFile(join(input, "payload", "nested", "sensitive.txt"), "private-results");
    const pair = keys();
    const sealed = await sealTaskPublication(input, identity, pair.publicKey);
    assert.doesNotMatch(
      sealed.toString("utf8"),
      /private-source|sensitive-project|private-results/
    );
    await assert.rejects(
      openTaskPublication(
        sealed,
        { ...identity, project: "different-project" },
        pair.privateKey,
        join(root, "unauthorized")
      ),
      /authenticate|decrypt|Unsupported|authenticity/i
    );
    await openTaskPublication(sealed, identity, pair.privateKey, opened);
    assert.equal(
      await readFile(join(opened, "payload", "nested", "sensitive.txt"), "utf8"),
      "private-results"
    );
    const altered = JSON.parse(sealed.toString("utf8")) as Record<string, string>;
    altered.tag = Buffer.alloc(16).toString("base64");
    await assert.rejects(
      openTaskPublication(
        Buffer.from(JSON.stringify(altered)),
        identity,
        pair.privateKey,
        join(root, "tampered")
      )
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("task publication sealing refuses symbolic links instead of archiving escapes", async () => {
  const root = await mkdtemp(join(tmpdir(), "aw-publication-symlink-test-"));
  try {
    await mkdir(join(root, "payload"), { recursive: true });
    await writeFile(join(root, "manifest.json"), "{}");
    await symlink("/etc/passwd", join(root, "payload", "leak"));
    await assert.rejects(sealTaskPublication(root, identity, keys().publicKey), /symbolic links/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("task execution has no GitHub App writer and publication runs on a fresh protected job", async () => {
  const source = await readFile(".github/workflows/handle-task-dispatch.yml", "utf8");
  const workflow = parse(source) as {
    jobs: Record<
      string,
      {
        needs?: string | string[];
        environment?: string;
        outputs?: Record<string, string>;
        steps: Array<{
          name?: string;
          uses?: string;
          env?: Record<string, string>;
          with?: Record<string, string>;
        }>;
      }
    >;
  };
  const execute = workflow.jobs.execute;
  const publish = workflow.jobs.publish;
  assert.ok(execute);
  assert.ok(publish);
  assert.equal(publish.environment, "admin-ops");
  const keyGuard = execute.steps.find(
    (step) => step.name === "Reject publisher private key in task execution"
  );
  assert.ok(keyGuard);
  assert.equal(
    keyGuard.env?.PUBLISHER_KEY_EXPOSED,
    "${{ secrets.AW_PUBLICATION_PRIVATE_KEY != '' }}"
  );
  assert.ok(
    execute.steps.findIndex(
      (step) => step.name === "Reject publisher private key in task execution"
    ) < execute.steps.findIndex((step) => step.name === "Execute downstream task")
  );
  assert.match(source, /AW_PUBLICATION_PRIVATE_KEY must be an admin-ops Environment Secret/);
  assert.deepEqual(publish.needs, ["validate", "execute"]);
  assert.equal(execute.outputs?.publication_staged, "${{ steps.publication.outputs.staged }}");
  assert.equal(
    execute.steps.some((step) => step.uses?.includes("mint-app-token")),
    false
  );
  assert.equal(
    execute.steps.some((step) => step.name === "Publish staged artifact"),
    false
  );
  assert.ok(execute.steps.some((step) => step.name === "Upload encrypted task publication"));
  const mint = publish.steps.find((step) => step.name === "Mint target publication App token");
  assert.equal(mint?.with?.["permission-contents"], "write");
  assert.equal(mint?.with?.["permission-pull-requests"], "write");
  assert.equal(mint?.with?.repositories, "${{ steps.target_scope.outputs.repository_name }}");
  assert.equal(
    publish.steps.find((step) => step.name === "Publish staged artifact")?.env?.GH_TOKEN,
    "${{ steps.target_app.outputs.token }}"
  );
  assert.doesNotMatch(source, /secrets\.AW_CONTROL_TOKEN/);
  assert.ok(
    source.includes("AW_PUBLICATION_PRIVATE_KEY: ${{ secrets.AW_PUBLICATION_PRIVATE_KEY }}")
  );
  assert.ok(source.includes("AW_PUBLICATION_PUBLIC_KEY: ${{ vars.AW_PUBLICATION_PUBLIC_KEY }}"));
  // The public control-plane run must not expose private task identity in step metadata.
  assert.doesNotMatch(source, /toJSON\(github\.event\.client_payload\)/);
  assert.match(source, /run: node scripts\/validate-dispatch-payload\.ts\n/);
  assert.match(source, /Shield and export verified task identity/);
  assert.equal(source.match(/Mask task identifiers in public logs/g)?.length, 2);
  assert.equal(source.match(/::add-mask::\$value/g)?.length, 3);
  const executeJob = source.split("  execute:")[1]?.split("  publish:")[0] ?? "";
  assert.doesNotMatch(executeJob.split("    steps:")[0] ?? "", /REQUEST_ID:|BOOTSTRAP_REF:|TASK_SOURCE_REPOSITORY:|PROJECT:/);
  // A publication PR must never silently skip central CI or governance.
  assert.match(source, /Central governance dispatch failed for publication PR/);
  assert.doesNotMatch(source, /event_type=run-intake[^\n]*\|\| true/);
  assert.equal(
    publish.steps.find((step) => step.name === "Mint control publication intake token")?.with?.[
      "permission-contents"
    ],
    "write"
  );
});
