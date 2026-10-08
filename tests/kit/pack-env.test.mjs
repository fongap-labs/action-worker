import assert from "node:assert/strict";
import { test } from "node:test";
import { baseEnvNames, buildPackEnv } from "./pack-env.mjs";

test("buildPackEnv drops CI tokens and local secrets from the host environment", () => {
  process.env.AW_ADMIN_TOKEN = "canary-admin";
  process.env.AW_CONTROL_TOKEN = "canary-control";
  process.env.AW_DISPATCH_TOKEN = "canary-dispatch";
  process.env.AIG_TOKEN_ENCRYPTION_KEY = "canary-aig";
  process.env.AIG_ACCESS_KEY_AGENT = "canary-aig-key";
  try {
    const env = buildPackEnv({}, "/tmp/target");
    assert.equal(!("AW_ADMIN_TOKEN" in env), true);
    assert.equal(!("AW_CONTROL_TOKEN" in env), true);
    assert.equal(!("AW_DISPATCH_TOKEN" in env), true);
    assert.equal(!("AIG_TOKEN_ENCRYPTION_KEY" in env), true);
    assert.equal(!("AIG_ACCESS_KEY_AGENT" in env), true);
  } finally {
    delete process.env.AW_ADMIN_TOKEN;
    delete process.env.AW_CONTROL_TOKEN;
    delete process.env.AW_DISPATCH_TOKEN;
    delete process.env.AIG_TOKEN_ENCRYPTION_KEY;
    delete process.env.AIG_ACCESS_KEY_AGENT;
  }
});

test("buildPackEnv always sets the target root and forwards base variables", () => {
  process.env.PATH = process.env.PATH || "/usr/bin";
  const env = buildPackEnv({}, "/repo/under/test");
  assert.equal(env.CENTRAL_TEST_TARGET_ROOT, "/repo/under/test");
  assert.ok(env.PATH || env.Path);
});

test("buildPackEnv forwards only manifest-declared names", () => {
  process.env.MY_PACK_CUSTOM_VAR = "present";
  process.env.OTHER_UNDECLARED_VAR = "present";
  try {
    const env = buildPackEnv({ env: ["MY_PACK_CUSTOM_VAR"] }, "/tmp/target");
    assert.equal(env.MY_PACK_CUSTOM_VAR, "present");
    assert.equal(!("OTHER_UNDECLARED_VAR" in env), true);
  } finally {
    delete process.env.MY_PACK_CUSTOM_VAR;
    delete process.env.OTHER_UNDECLARED_VAR;
  }
});

test("buildPackEnv rejects invalid declared names", () => {
  assert.throws(() => buildPackEnv({ env: ["lowercase_name"] }), /not a valid variable name/);
  assert.throws(() => buildPackEnv({ env: ["9STARTS_WITH_DIGIT"] }), /not a valid variable name/);
  assert.throws(() => buildPackEnv({ env: ["HAS-DASH"] }), /not a valid variable name/);
  assert.throws(() => buildPackEnv({ env: [42] }), /array of strings/);
});

test("buildPackEnv forwards Windows mixed-case base variables case-insensitively", () => {
  const previous = process.env.COMSPEC;
  process.env.ComSpec = "C:\\Windows\\system32\\cmd.exe";
  try {
    const env = buildPackEnv({}, "/tmp/target");
    const values = Object.values(env);
    assert.ok(values.includes("C:\\Windows\\system32\\cmd.exe"));
  } finally {
    if (previous === undefined) delete process.env.ComSpec;
    else process.env.COMSPEC = previous;
  }
});

test("baseEnvNames excludes every credential-shaped family", () => {
  const names = baseEnvNames();
  for (const name of names) {
    assert.equal(!/^(AW|AIG)_/.test(name), true, `base set must not contain ${name}`);
  }
});
