import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";
import {
  openTaskPublication,
  sealTaskPublication,
  verifyPublicationKeyPair,
} from "../scripts/task-publication-envelope.ts";
import { validateManifest } from "../scripts/validate-task-publication.ts";

const identity = {
  repository: "fongap-labs/private-source",
  project: "sensitive-project",
  bootstrap_ref: "a".repeat(40),
  request_id: "task-123",
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
    await assert.rejects(
      openTaskPublication(
        sealed,
        { ...identity, request_id: "task-124" },
        pair.privateKey,
        join(root, "wrong-request")
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

test("publication key pairing fails closed for a mismatched RSA key", () => {
  const good = keys();
  const wrong = keys();
  assert.doesNotThrow(() => verifyPublicationKeyPair(good.publicKey, good.privateKey));
  assert.throws(
    () => verifyPublicationKeyPair(good.publicKey, wrong.privateKey),
    /public and private keys do not match/
  );
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
  const validate = workflow.jobs.validate;
  assert.ok(validate);
  assert.equal(
    validate.steps.find((step) => step.name === "Validate task source")?.env?.AW_STATUS_KEYRING,
    "${{ secrets.AW_STATUS_KEYRING }}"
  );
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
  assert.ok(publish.steps.some((step) => step.name === "Verify protected publication key pair"));
  const opener = publish.steps.find(
    (step) => step.name === "Open encrypted publication on clean runner"
  );
  assert.equal(opener?.env?.REQUEST_ID, "${{ needs.validate.outputs.request_id }}");
  // The public control-plane run must not expose private task identity in step metadata.
  assert.doesNotMatch(source, /toJSON\(github\.event\.client_payload\)/);
  assert.match(source, /run: node scripts\/validate-dispatch-payload\.ts\n/);
  assert.match(source, /Shield and export verified task identity/);
  assert.equal(source.match(/Mask task identifiers in public logs/g)?.length, 2);
  assert.equal(source.match(/::add-mask::\$value/g)?.length, 3);
  const executeJob = source.split("  execute:")[1]?.split("  publish:")[0] ?? "";
  assert.doesNotMatch(
    executeJob.split("    steps:")[0] ?? "",
    /REQUEST_ID:|BOOTSTRAP_REF:|TASK_SOURCE_REPOSITORY:|PROJECT:/
  );
  // A publication PR must never silently skip central CI or governance.
  assert.match(source, /Central governance dispatch failed for publication PR/);
  assert.match(source, /Publication destination traverses a target repository symlink/);
  assert.match(source, /Publication destination contains an unsafe existing symlink/);
  const nestedGuard = source.indexOf('find "$target_dir" -type l -print -quit');
  const copy = source.indexOf('cp -a "$PAYLOAD_DIR"');
  assert.ok(nestedGuard > 0 && copy > nestedGuard);
  assert.doesNotMatch(source, /event_type=run-intake[^\n]*\|\| true/);
  assert.equal(
    publish.steps.find((step) => step.name === "Mint control publication intake token")?.with?.[
      "permission-contents"
    ],
    "write"
  );
});

test("publication destination rejects Git metadata and unsafe path segments", () => {
  const publication = {
    schema_version: "1",
    target_repository: "fongap-labs/target",
    dest_dir: "output/report/2026-11-05",
    delete_stale: true,
    commit_message: "chore: publish task outputs",
  };
  assert.equal(validateManifest(publication).dest_dir, publication.dest_dir);
  for (const dest_dir of [
    ".git/hooks",
    ".github/workflows",
    "output/.git/hooks",
    "output/.hidden",
    "output/../secrets",
    "output//report",
    "output/report\nname",
  ]) {
    assert.throws(
      () => validateManifest({ ...publication, dest_dir }),
      /Task publication destination is invalid/
    );
  }
});

test("task request is loaded from GitHub event file without printing the payload", async () => {
  const root = await mkdtemp(join(tmpdir(), "aw-event-input-test-"));
  try {
    const eventPath = join(root, "event.json");
    const outputPath = join(root, "outputs");
    await writeFile(
      eventPath,
      JSON.stringify({
        action: "run-task",
        client_payload: {
          schema_version: "1",
          request_id: "private-request",
          project: "sensitive-project",
          bootstrap_ref: identity.bootstrap_ref,
          repository: identity.repository,
        },
      })
    );
    const stdout = execFileSync(process.execPath, ["scripts/validate-dispatch-payload.ts"], {
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_OUTPUT: outputPath,
        AW_REPOSITORY_POLICY: JSON.stringify({ [identity.repository]: ["task"] }),
      },
    });
    assert.equal(stdout, "");
    const outputs = await readFile(outputPath, "utf8");
    assert.match(outputs, /project=sensitive-project/);
    assert.match(outputs, /repository=fongap-labs\/private-source/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("task publication CLI seals in executor and opens on a separate clean publisher", async () => {
  const root = await mkdtemp(join(tmpdir(), "aw-publication-cli-test-"));
  try {
    const staged = join(root, "staged");
    const sealedPath = join(root, "sealed.json");
    const opened = join(root, "opened");
    await mkdir(join(staged, "payload"), { recursive: true });
    await writeFile(
      join(staged, "manifest.json"),
      JSON.stringify({ target_repository: "fongap-labs/target" })
    );
    await writeFile(join(staged, "payload", "result.txt"), "confidential-output");
    const pair = keys();
    const sourceEnv = {
      ...process.env,
      TASK_SOURCE_REPOSITORY: identity.repository,
      PROJECT: identity.project,
      BOOTSTRAP_REF: identity.bootstrap_ref,
      REQUEST_ID: identity.request_id,
    };
    execFileSync(
      process.execPath,
      ["scripts/task-publication-envelope.ts", "seal", staged, sealedPath],
      {
        env: {
          ...sourceEnv,
          AW_PUBLICATION_PUBLIC_KEY: pair.publicKey,
          AW_PUBLICATION_PRIVATE_KEY: "",
        },
      }
    );
    assert.doesNotMatch(
      await readFile(sealedPath, "utf8"),
      /private-source|sensitive-project|confidential-output/
    );
    assert.equal(
      execFileSync(process.execPath, ["scripts/task-publication-envelope.ts", "check-keys"], {
        encoding: "utf8",
        env: {
          ...sourceEnv,
          AW_PUBLICATION_PUBLIC_KEY: pair.publicKey,
          AW_PUBLICATION_PRIVATE_KEY: pair.privateKey,
        },
      }).trim(),
      "Publication key pair validated."
    );
    execFileSync(
      process.execPath,
      ["scripts/task-publication-envelope.ts", "open", sealedPath, opened],
      {
        env: {
          ...sourceEnv,
          AW_PUBLICATION_PUBLIC_KEY: "",
          AW_PUBLICATION_PRIVATE_KEY: pair.privateKey,
        },
      }
    );
    assert.equal(
      await readFile(join(opened, "payload", "result.txt"), "utf8"),
      "confidential-output"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("private task publication masks target metadata before policy authorization", async () => {
  const source = await readFile("scripts/validate-task-publication.ts", "utf8");
  const mask = source.indexOf("console.log(`::add-mask::${escaped}`)");
  const policy = source.indexOf(
    'validateRepositoryCapability(sourceRepository, policy, "release-source")'
  );
  assert.ok(mask > 0 && mask < policy);
  assert.match(source, /manifest\.target_repository, manifest\.dest_dir, manifest\.commit_message/);
});
