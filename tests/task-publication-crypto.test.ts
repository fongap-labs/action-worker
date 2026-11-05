import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  openTaskPublication,
  sealTaskPublication,
  verifyPublicationKeyPair,
} from "../scripts/task-publication-envelope.ts";

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
