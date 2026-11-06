import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { privateTaskDockerArguments } from "../../scripts/private-task-container.ts";
import {
  openTaskPublication,
  sealTaskPublication,
} from "../../scripts/task-publication-envelope.ts";

const image = `ghcr.io/fongap-labs/private-sandbox@sha256:${"a".repeat(64)}`;
const dockerImage = process.env.AW_SANDBOX_TEST_IMAGE_ID ?? "";
const identity = {
  repository: "fongap-labs/synthetic-private-e2e",
  project: "sandbox",
  bootstrap_ref: "c".repeat(40),
  request_id: "publication-test",
};

function runSyntheticTask(
  source: string,
  state: string,
  publication: string,
  logFile: string
): number {
  const args = privateTaskDockerArguments({
    image,
    sourceDirectory: source,
    stateDirectory: state,
    publicationDirectory: publication,
    logFile,
    repository: identity.repository,
    project: identity.project,
    bootstrapRef: identity.bootstrap_ref,
    requestId: identity.request_id,
    userId: process.getuid?.() ?? 0,
    groupId: process.getgid?.() ?? 0,
    taskCredentials: {},
  });
  args[args.indexOf(image)] = dockerImage;
  const fd = openSync(logFile, "wx", 0o600);
  try {
    const result = spawnSync("docker", args, {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      stdio: ["ignore", fd, fd],
      timeout: 60_000,
    });
    if (result.error) throw result.error;
    return result.status ?? 124;
  } finally {
    closeSync(fd);
  }
}

test("real private sandbox stages authorized publication without private key or cleartext Artifact", {
  timeout: 120_000,
}, async () => {
  assert.match(dockerImage, /^sha256:[a-f0-9]{64}$/);
  const root = await mkdtemp(join(tmpdir(), "aw-private-publish-e2e-"));
  const source = join(root, "source");
  const state = join(root, "state");
  const publication = join(root, "publication");
  const staged = join(publication, "action-worker-publication");
  try {
    await mkdir(source);
    await mkdir(state);
    await mkdir(publication);
    const manifest = {
      schema_version: "1",
      target_repository: "fongap-labs/synthetic-target",
      dest_dir: "reports/sandbox",
      delete_stale: false,
      commit_message: "chore: publish synthetic private report",
    };
    await writeFile(
      join(source, "bootstrap.sh"),
      [
        "set -Eeuo pipefail",
        'test -z "${AW_PUBLICATION_PRIVATE_KEY:-}"',
        'test -z "${AW_APP_PRIVATE_KEY:-}"',
        'test -z "${GH_TOKEN:-}"',
        "test ! -e /var/run/docker.sock",
        "if touch /task-source/not-allowed 2>/dev/null; then exit 71; fi",
        'mkdir -p "$RUNNER_TEMP/action-worker-publication/payload"',
        `printf '%s' '${JSON.stringify(manifest)}' > "$RUNNER_TEMP/action-worker-publication/manifest.json"`,
        'echo PRIVATE_PUBLICATION_SENTINEL > "$RUNNER_TEMP/action-worker-publication/payload/report.txt"',
        "",
      ].join("\n")
    );
    await chmod(join(source, "bootstrap.sh"), 0o755);
    const log = join(root, "private.log");
    assert.equal(runSyntheticTask(source, state, publication, log), 0);
    assert.equal(
      await readFile(join(staged, "payload", "report.txt"), "utf8"),
      "PRIVATE_PUBLICATION_SENTINEL\n"
    );

    const policy = {
      [identity.repository]: ["release-source"],
      "fongap-labs/synthetic-target": ["release-target", "pr"],
    };
    const output = join(root, "validation-output");
    const validated = spawnSync(process.execPath, ["scripts/validate-task-publication.ts"], {
      env: {
        ...process.env,
        RUNNER_TEMP: publication,
        SOURCE_REPOSITORY: identity.repository,
        TASK_SOURCE_PRIVATE: "true",
        AW_REPOSITORY_POLICY: JSON.stringify(policy),
        GITHUB_OUTPUT: output,
      },
      encoding: "utf8",
    });
    assert.equal(validated.status, 0, validated.stderr);
    assert.match(await readFile(output, "utf8"), /staged=true/);
    const lines = validated.stdout.trim().split("\n");
    assert.equal(lines.filter((line) => line.startsWith("::add-mask::")).length, 3);
    assert.doesNotMatch(
      lines.filter((line) => !line.startsWith("::add-mask::")).join("\n"),
      /synthetic-target|reports\/sandbox/
    );
    const keys = generateKeyPairSync("rsa", {
      modulusLength: 3072,
      publicKeyEncoding: { format: "der", type: "spki" },
      privateKeyEncoding: { format: "pem", type: "pkcs8" },
    });
    const encrypted = await sealTaskPublication(
      staged,
      identity,
      keys.publicKey.toString("base64")
    );
    assert.doesNotMatch(
      encrypted.toString("utf8"),
      /PRIVATE_PUBLICATION_SENTINEL|synthetic-target/
    );
    const sealed = join(root, "publication.seal");
    await writeFile(sealed, encrypted, { mode: 0o600 });
    assert.deepEqual(await readFile(sealed), encrypted);
    await assert.rejects(
      openTaskPublication(
        encrypted,
        { ...identity, request_id: "wrong-request" },
        keys.privateKey,
        join(root, "unauthorized")
      ),
      /authenticate|decrypt|authenticity/i
    );
    const opened = join(root, "publisher-only");
    await openTaskPublication(encrypted, identity, keys.privateKey, opened);
    assert.equal(
      await readFile(join(opened, "payload", "report.txt"), "utf8"),
      "PRIVATE_PUBLICATION_SENTINEL\n"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
