import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
