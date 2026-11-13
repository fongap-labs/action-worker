import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { configureNpmAuth, npmPublishArgs, npmRegistry } from "../scripts/npm-publish.ts";

test("npm auth uses a temporary .npmrc with environment token interpolation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "action-worker-npm-auth-test-"));
  const token = "test-token-never-written-to-disk";
  try {
    const env = await configureNpmAuth(directory, token);
    const config = await readFile(join(directory, ".npmrc"), "utf8");
    assert.equal(
      config,
      "registry=https://registry.npmjs.org/\n//registry.npmjs.org/:_authToken=\u0024{NODE_AUTH_TOKEN}\n"
    );
    assert.equal(env.NODE_AUTH_TOKEN, token);
    assert.equal(env.npm_config_registry, npmRegistry);
    assert.equal(config.includes(token), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("beta and other prereleases are rejected before npm starts", () => {
  for (const version of ["0.1.0-beta.2", "1.2.3-rc.1", "1.2.3+build.5", "latest"]) {
    assert.throws(
      () => npmPublishArgs("package.tgz", version),
      /npm publishing accepts only stable X.Y.Z versions/
    );
  }
});

test("stable tarballs publish under npm's default dist-tag", () => {
  assert.deepEqual(npmPublishArgs("package.tgz", "1.2.3"), [
    "publish",
    "package.tgz",
    "--access",
    "public",
  ]);
});
