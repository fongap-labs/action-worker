import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveSecretScope } from "../scripts/resolve-secret-scope.ts";

test("secret scope exposes only source-declared secrets", async () => {
  const root = await mkdtemp(join(tmpdir(), "secret-scope-"));
  const baseline = join(root, "baseline");
  const required = join(root, "required");
  const allowed = join(root, "allowed");
  await writeFile(baseline, "PATH\nPROJECT\n");
  await writeFile(required, "APP_REQUIRED\n");
  await writeFile(allowed, "APP_OPTIONAL\n");

  const scope = await resolveSecretScope(
    baseline,
    required,
    allowed,
    [],
    {
      PATH: "/bin",
      PROJECT: "example",
      APP_REQUIRED: "required",
      APP_OPTIONAL: "optional",
      OTHER_SECRET: "hidden",
      AW_CONTROL_TOKEN: "hidden",
    },
  );
  assert.deepEqual(scope.allowed, ["APP_OPTIONAL", "APP_REQUIRED"]);
  assert.deepEqual(scope.required, ["APP_REQUIRED"]);
  assert.deepEqual(scope.unset, ["AW_CONTROL_TOKEN", "OTHER_SECRET"]);
});

test("base control-plane secrets can never be requested", async () => {
  const root = await mkdtemp(join(tmpdir(), "secret-scope-"));
  const baseline = join(root, "baseline");
  const required = join(root, "required");
  await writeFile(baseline, "PATH\n");
  await writeFile(required, "AW_CONTROL_TOKEN\n");
  await assert.rejects(
    resolveSecretScope(baseline, required, "", [], { PATH: "/bin", AW_CONTROL_TOKEN: "x" }),
    /invalid or reserved/,
  );
});

test("capability-specific denied secrets remain unavailable to tasks", async () => {
  const root = await mkdtemp(join(tmpdir(), "secret-scope-"));
  const baseline = join(root, "baseline");
  const allowed = join(root, "allowed");
  await writeFile(baseline, "PATH\n");
  await writeFile(allowed, "AIG_ACCESS_KEY_AGENT\n");
  await assert.rejects(
    resolveSecretScope(
      baseline,
      "",
      allowed,
      ["AIG_ACCESS_KEY_AGENT"],
      { PATH: "/bin", AIG_ACCESS_KEY_AGENT: "agent-key" },
    ),
    /denied for this capability/,
  );
});

test("privileged deploy may expose an explicitly declared application secret", async () => {
  const root = await mkdtemp(join(tmpdir(), "secret-scope-"));
  const baseline = join(root, "baseline");
  const allowed = join(root, "allowed");
  await writeFile(baseline, "PATH\n");
  await writeFile(allowed, "AIG_ACCESS_KEY_AGENT\n");
  const scope = await resolveSecretScope(
    baseline,
    "",
    allowed,
    [],
    {
      PATH: "/bin",
      AIG_ACCESS_KEY_AGENT: "agent-key",
      AW_CONTROL_TOKEN: "control",
      OTHER_SECRET: "hidden",
    },
  );
  assert.deepEqual(scope.allowed, ["AIG_ACCESS_KEY_AGENT"]);
  assert.deepEqual(scope.unset, ["AW_CONTROL_TOKEN", "OTHER_SECRET"]);
});
