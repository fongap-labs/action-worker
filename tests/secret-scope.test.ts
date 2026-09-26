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

test("secret scope rejects control-plane secret requests", async () => {
  const root = await mkdtemp(join(tmpdir(), "secret-scope-"));
  const baseline = join(root, "baseline");
  const required = join(root, "required");
  await writeFile(baseline, "PATH\n");
  await writeFile(required, "AW_CONTROL_TOKEN\n");
  await assert.rejects(
    resolveSecretScope(baseline, required, "", { PATH: "/bin", AW_CONTROL_TOKEN: "x" }),
  );
});
