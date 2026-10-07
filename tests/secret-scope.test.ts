import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readTaskSecretCeiling, resolveSecretScope } from "../scripts/resolve-secret-scope.ts";

test("secret scope exposes only source-declared secrets", async () => {
  const root = await mkdtemp(join(tmpdir(), "secret-scope-"));
  const baseline = join(root, "baseline");
  const required = join(root, "required");
  const allowed = join(root, "allowed");
  await writeFile(baseline, "PATH\nPROJECT\n");
  await writeFile(required, "APP_REQUIRED\n");
  await writeFile(allowed, "APP_OPTIONAL\n");

  const scope = await resolveSecretScope(baseline, required, allowed, [], {
    PATH: "/bin",
    PROJECT: "example",
    APP_REQUIRED: "required",
    APP_OPTIONAL: "optional",
    OTHER_SECRET: "hidden",
    AW_CONTROL_TOKEN: "hidden",
  });
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
    /invalid or reserved/
  );
});

test("capability-specific denied secrets remain unavailable to tasks", async () => {
  const root = await mkdtemp(join(tmpdir(), "secret-scope-"));
  const baseline = join(root, "baseline");
  const allowed = join(root, "allowed");
  await writeFile(baseline, "PATH\n");
  await writeFile(allowed, "AIG_ACCESS_KEY_AGENT\n");
  await assert.rejects(
    resolveSecretScope(baseline, "", allowed, ["AIG_ACCESS_KEY_AGENT"], {
      PATH: "/bin",
      AIG_ACCESS_KEY_AGENT: "agent-key",
    }),
    /denied for this capability/
  );
});

test("privileged deploy may expose an explicitly declared application secret", async () => {
  const root = await mkdtemp(join(tmpdir(), "secret-scope-"));
  const baseline = join(root, "baseline");
  const allowed = join(root, "allowed");
  await writeFile(baseline, "PATH\n");
  await writeFile(allowed, "AIG_ACCESS_KEY_AGENT\n");
  const scope = await resolveSecretScope(baseline, "", allowed, [], {
    PATH: "/bin",
    AIG_ACCESS_KEY_AGENT: "agent-key",
    AW_CONTROL_TOKEN: "control",
    OTHER_SECRET: "hidden",
  });
  assert.deepEqual(scope.allowed, ["AIG_ACCESS_KEY_AGENT"]);
  assert.deepEqual(scope.unset, ["AW_CONTROL_TOKEN", "OTHER_SECRET"]);
});

async function scopeFiles(requiredNames: string, allowedNames: string) {
  const root = await mkdtemp(join(tmpdir(), "secret-scope-"));
  const files = {
    baseline: join(root, "baseline"),
    required: join(root, "required"),
    allowed: join(root, "allowed"),
  };
  await writeFile(files.baseline, "PATH\n");
  await writeFile(files.required, requiredNames);
  await writeFile(files.allowed, allowedNames);
  return { root, ...files };
}

test("central task secret ceiling only reports in warn mode", async () => {
  const { baseline, required, allowed } = await scopeFiles("APP_REQUIRED\n", "APP_EXTRA\n");
  const environment = { PATH: "/bin", APP_REQUIRED: "x", APP_EXTRA: "y" };

  const within = await resolveSecretScope(baseline, required, allowed, [], environment, {
    names: new Set(["APP_REQUIRED", "APP_EXTRA", "APP_UNUSED"]),
    mode: "warn",
  });
  assert.deepEqual(within.policy_excess, []);

  const warned = await resolveSecretScope(baseline, required, allowed, [], environment, {
    names: new Set(["APP_REQUIRED"]),
    mode: "warn",
  });
  assert.deepEqual(warned.policy_excess, ["APP_EXTRA"]);
  assert.deepEqual(warned.allowed, ["APP_EXTRA", "APP_REQUIRED"]);
  assert.deepEqual(warned.unset, []);

  const unchecked = await resolveSecretScope(baseline, required, allowed, [], environment);
  assert.deepEqual(unchecked.policy_excess, []);
});

test("central task secret ceiling rejects undeclared names in enforce mode", async () => {
  const { baseline, required, allowed } = await scopeFiles("APP_REQUIRED\n", "APP_EXTRA\n");
  await assert.rejects(
    resolveSecretScope(
      baseline,
      required,
      allowed,
      [],
      { PATH: "/bin", APP_REQUIRED: "x" },
      {
        names: new Set(["APP_REQUIRED"]),
        mode: "enforce",
      }
    ),
    /outside the central task secret policy: APP_EXTRA/
  );
  await assert.rejects(
    resolveSecretScope(
      baseline,
      required,
      allowed,
      [],
      { PATH: "/bin", APP_REQUIRED: "x" },
      {
        names: new Set(),
        mode: "enforce",
      }
    ),
    /APP_EXTRA, APP_REQUIRED/
  );
});

test("task secret policy is read per repository and project and fails closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "secret-policy-"));
  const policyPath = join(root, "task-secrets.json");
  await writeFile(
    policyPath,
    JSON.stringify({
      schema_version: 1,
      tasks: { "owner/repo": { Alpha: { required: ["A_ONE"], allowed: ["A_TWO"] }, Beta: {} } },
    })
  );
  assert.deepEqual([...(await readTaskSecretCeiling(policyPath, "owner/repo", "Alpha"))].sort(), [
    "A_ONE",
    "A_TWO",
  ]);
  assert.equal((await readTaskSecretCeiling(policyPath, "owner/repo", "Beta")).size, 0);
  assert.equal((await readTaskSecretCeiling(policyPath, "owner/repo", "Gamma")).size, 0);
  assert.equal((await readTaskSecretCeiling(policyPath, "owner/other", "Alpha")).size, 0);

  for (const bad of [
    { schema_version: 2, tasks: {} },
    { schema_version: 1 },
    { schema_version: 1, tasks: { "owner/repo": { Alpha: { required: ["AW_CONTROL_TOKEN"] } } } },
    { schema_version: 1, tasks: { "owner/repo": { Alpha: { allowed: "A_ONE" } } } },
    { schema_version: 1, tasks: { "owner/repo": { Alpha: { allowed: ["lower_case"] } } } },
  ]) {
    await writeFile(policyPath, JSON.stringify(bad));
    await assert.rejects(
      readTaskSecretCeiling(policyPath, "owner/repo", "Alpha"),
      /Task secret policy/
    );
  }
});

test("shipped task secret policy is valid and denies unknown tasks", async () => {
  const policyPath = "policies/task-secrets.json";
  const blog = await readTaskSecretCeiling(policyPath, "fongap-labs/internal-vault", "FongapBlog");
  assert.equal(blog.has("CLOUDFLARE_API_TOKEN"), true);
  assert.equal(blog.has("AIG_ACCESS_KEY_AGENT"), false);
  assert.equal((await readTaskSecretCeiling(policyPath, "fongap-labs/unknown", "Any")).size, 0);
  assert.equal(
    (await readTaskSecretCeiling(policyPath, "fongap-labs/ai-gateway", "model-discovery")).size,
    30
  );
});
