import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildScopedDeployEnvironment,
  loadScopedSecretValues,
} from "../scripts/run-scoped-deploy.ts";
import { stageDeploySecretSlots } from "../scripts/stage-deploy-secret-bundle.ts";

test("only declared Secret slots are staged and the source gets only approved values", async () => {
  const root = await mkdtemp(join(tmpdir(), "deploy-slots-"));
  try {
    const plan = {
      schema_version: 1 as const,
      secrets: [
        { name: "TOKEN_A", source: "TOKEN_SOURCE_A", required: true, kind: "secret" as const },
        { name: "TOKEN_B", source: "TOKEN_SOURCE_B", required: false, kind: "secret" as const },
        { name: "ACCOUNT", source: "ACCOUNT_VARIABLE", required: true, kind: "variable" as const },
      ],
    };
    const env = {
      AW_DEPLOY_SECRET_00: "value-a",
      AW_DEPLOY_SECRET_01: "",
      AW_DEPLOY_SECRET_02: "ignored",
    };
    await stageDeploySecretSlots(env, plan, root);
    const values = await loadScopedSecretValues(join(root, "action-worker-deploy-secrets"), plan);
    assert.deepEqual([...values], [["TOKEN_A", "value-a"]]);
    assert.equal(
      await readFile(join(root, "action-worker-deploy-secrets", "TOKEN_A"), "utf8"),
      "value-a"
    );
    const scoped = buildScopedDeployEnvironment(
      { PATH: "/bin", AW_CONTROL_TOKEN: "ctl", OTHER: "x", GH_TOKEN: "git" },
      plan,
      values,
      { ACCOUNT_VARIABLE: "acct", PUBLIC_APP_URL: "https://example.test" }
    );
    assert.equal(scoped.TOKEN_A, "value-a");
    assert.equal(scoped.ACCOUNT, "acct");
    assert.equal(scoped.PUBLIC_APP_URL, "https://example.test");
    assert.equal(scoped.ACCOUNT_VARIABLE, undefined);
    assert.equal(scoped.AW_CONTROL_TOKEN, undefined);
    assert.equal(scoped.GH_TOKEN, undefined);
    assert.equal(scoped.OTHER, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("all required Secrets must exist before any sensitive value is staged", async () => {
  const root = await mkdtemp(join(tmpdir(), "deploy-slots-"));
  try {
    const plan = {
      schema_version: 1 as const,
      secrets: [
        { name: "TOKEN_A", source: "TOKEN_SOURCE_A", required: true, kind: "secret" as const },
        { name: "TOKEN_B", source: "TOKEN_SOURCE_B", required: true, kind: "secret" as const },
      ],
    };
    await assert.rejects(
      stageDeploySecretSlots({ AW_DEPLOY_SECRET_00: "sensitive-first-value" }, plan, root),
      /Required deploy Secret is unavailable/
    );
    await assert.rejects(stat(join(root, "action-worker-deploy-secrets")), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("forged Secret plan paths fail closed before any file is staged", async () => {
  const root = await mkdtemp(join(tmpdir(), "deploy-slots-"));
  try {
    for (const entries of [
      [{ name: "../escape", source: "SOURCE", required: true, kind: "secret" as const }],
      [
        { name: "TOKEN_A", source: "SOURCE", required: true, kind: "secret" as const },
        { name: "TOKEN_A", source: "OTHER", required: false, kind: "secret" as const },
      ],
    ]) {
      await assert.rejects(
        stageDeploySecretSlots(
          { AW_DEPLOY_SECRET_00: "sensitive-first-value" },
          { schema_version: 1, secrets: entries },
          root
        ),
        /invalid or duplicated binding/
      );
    }
    await assert.rejects(stat(join(root, "action-worker-deploy-secrets")), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("partial write failure removes only files created by the staging attempt", async () => {
  const root = await mkdtemp(join(tmpdir(), "deploy-slots-"));
  const directory = join(root, "action-worker-deploy-secrets");
  try {
    await mkdir(directory);
    const preexisting = join(directory, "TOKEN_B");
    await writeFile(preexisting, "pre-existing-file", { mode: 0o600 });
    const plan = {
      schema_version: 1 as const,
      secrets: [
        { name: "TOKEN_A", source: "SOURCE_A", required: true, kind: "secret" as const },
        { name: "TOKEN_B", source: "SOURCE_B", required: true, kind: "secret" as const },
      ],
    };
    await assert.rejects(
      stageDeploySecretSlots(
        { AW_DEPLOY_SECRET_00: "sensitive-first-value", AW_DEPLOY_SECRET_01: "value-b" },
        plan,
        root
      ),
      { code: "EEXIST" }
    );
    await assert.rejects(stat(join(directory, "TOKEN_A")), { code: "ENOENT" });
    assert.equal(await readFile(preexisting, "utf8"), "pre-existing-file");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("required missing Secret slot fails closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "deploy-slots-"));
  try {
    const plan = {
      schema_version: 1 as const,
      secrets: [
        { name: "TOKEN_A", source: "TOKEN_SOURCE_A", required: true, kind: "secret" as const },
      ],
    };
    await assert.rejects(
      stageDeploySecretSlots({}, plan, root),
      /Required deploy Secret is unavailable/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
