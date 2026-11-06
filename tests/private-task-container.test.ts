import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  type PrivateTaskContainerSettings,
  privateTaskDockerArguments,
  runPrivateTaskContainer,
} from "../scripts/private-task-container.ts";

const image = `ghcr.io/fongap-labs/task-runtime@sha256:${"a".repeat(64)}`;
const settings = (root: string): PrivateTaskContainerSettings => ({
  image,
  sourceDirectory: join(root, "source"),
  stateDirectory: join(root, "state"),
  logFile: join(root, "private.log"),
  repository: "fongap-labs/private-repository",
  project: "build",
  bootstrapRef: "b".repeat(40),
  requestId: "req-1",
  userId: 1001,
  groupId: 1001,
  taskCredentials: {},
});

test("private task container has an immutable image and explicit nonprivileged isolation arguments", () => {
  const args = privateTaskDockerArguments(settings("/tmp/secure-pilot"));
  const joined = args.join(" ");
  for (const flag of [
    "--rm",
    "--pull=never",
    "--network=none",
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--pids-limit=128",
    "--memory=1g",
    "--cpus=2",
  ])
    assert.ok(args.includes(flag), flag);
  assert.ok(args.includes("--user"));
  assert.ok(args.includes("1001:1001"));
  assert.ok(args.includes(image));
  assert.ok(
    args.includes("type=bind,source=/tmp/secure-pilot/source,target=/task-source,readonly")
  );
  assert.ok(args.includes("type=bind,source=/tmp/secure-pilot/state,target=/task-state"));
  assert.ok(args.includes("/bin/bash"));
  assert.ok(args.includes("/task-source/bootstrap.sh"));
  assert.doesNotMatch(joined, /docker\.sock|AW_ARTIFACT_KEY|AW_APP_PRIVATE_KEY|AW_ADMIN_TOKEN/);
  assert.ok(args.indexOf(image) < args.indexOf("/bin/bash"));
});

test("container arguments refuse mutable images, host root UID, and invalid identity", () => {
  const base = settings("/tmp/secure-pilot");
  for (const changes of [
    { image: "ubuntu:latest" },
    { image: "ghcr.io/fongap-labs/task-runtime:latest" },
    { image: `docker.io/unknown/image@sha256:${"a".repeat(64)}` },
    { image: `ghcr.io/fongap-labs/task-runtime@sha256:${"a".repeat(63)}` },
    { userId: 0 },
    { groupId: 0 },
    { sourceDirectory: "relative" },
    { stateDirectory: "../relative" },
    { stateDirectory: "/tmp/state,readonly" },
    { sourceDirectory: "/tmp/source,bind-propagation=shared" },
    { bootstrapRef: "main" },
    { requestId: "../escape" },
    { project: "../escape" },
  ])
    assert.throws(() => privateTaskDockerArguments({ ...base, ...changes }), /security contract/);
});

test("private task denies central credentials and any unsupported business Secret injection", () => {
  const base = settings("/tmp/secure-pilot");
  const deniedCredentials: Array<Record<string, string>> = [
    { AW_ARTIFACT_KEY: "root" },
    { AW_APP_PRIVATE_KEY: "root" },
    { GH_TOKEN: "root" },
    { NODE_OPTIONS: "--require malicious" },
    { API_KEY: "not-yet-reviewed" },
  ];
  for (const taskCredentials of deniedCredentials) {
    assert.throws(
      () => privateTaskDockerArguments({ ...base, taskCredentials }),
      /security contract/
    );
  }
});

test("private task refuses workspace symlinks and overlap before running Docker", async () => {
  const root = await mkdtemp(join(tmpdir(), "aw-container-"));
  try {
    await mkdir(join(root, "source"));
    await mkdir(join(root, "state"));
    await symlink(join(root, "source"), join(root, "alias"));
    await assert.rejects(
      runPrivateTaskContainer({
        ...settings(root),
        sourceDirectory: join(root, "alias"),
      }),
      /security contract/
    );
    await assert.rejects(
      runPrivateTaskContainer({
        ...settings(root),
        stateDirectory: join(root, "source"),
      }),
      /security contract/
    );
    await assert.rejects(
      runPrivateTaskContainer({
        ...settings(root),
        taskCredentials: { BUSINESS_KEY: "unsupported" },
      }),
      /security contract/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("private task never starts Docker or truncates a preexisting log on invalid input", async () => {
  const root = await mkdtemp(join(tmpdir(), "aw-container-"));
  try {
    await mkdir(join(root, "source"));
    await mkdir(join(root, "state"));
    const logFile = join(root, "private.log");
    await writeFile(logFile, "sentinel");
    await assert.rejects(
      runPrivateTaskContainer({ ...settings(root), image: "task-runtime:latest" }),
      /security contract/
    );
    assert.equal(await readFile(logFile, "utf8"), "sentinel");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
