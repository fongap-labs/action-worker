import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { configureNpmAuth, npmAuthConfig, npmPublishArgs, npmRegistry } from "../scripts/npm-publish.ts";

test("npm auth uses a temporary registry-scoped config with environment interpolation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "action-worker-npm-auth-test-"));
  const token = "test-token-never-written-to-disk";
  try {
    const env = await configureNpmAuth(directory, token);
    const config = await readFile(join(directory, ".npmrc"), "utf8");
    assert.equal(
      config,
      "registry=https://registry.npmjs.org/\n//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}\n"
    );
    assert.equal(env.NODE_AUTH_TOKEN, token);
    assert.equal(env.npm_config_registry, npmRegistry);
    assert.equal(config.includes(token), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("beta tarballs publish under the beta dist-tag", () => {
  assert.deepEqual(npmPublishArgs("package.tgz", "0.1.0-beta.2"), [
    "publish", "package.tgz", "--access", "public", "--tag", "beta",
  ]);
});

test("stable tarballs publish under npm's default dist-tag", () => {
  assert.deepEqual(npmPublishArgs("package.tgz", "1.2.3"), [
    "publish", "package.tgz", "--access", "public",
  ]);
});
