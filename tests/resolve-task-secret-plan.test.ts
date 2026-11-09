import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  resolveTaskSecretPlan,
  validateTaskSecretSlots,
} from "../scripts/resolve-task-secret-plan.ts";

const repository = "fongap-labs/example";
const project = "Demo";

async function fixture(declaration: { required: string; allowed: string }, policy: unknown) {
  const root = await mkdtemp(join(tmpdir(), "aw-task-scoped-secrets-"));
  const source = join(root, "source");
  const directory = join(source, "projects", project);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, ".secrets.required"), declaration.required);
  await writeFile(join(directory, ".secrets.allowed"), declaration.allowed);
  const policyPath = join(root, "policy.json");
  await writeFile(policyPath, JSON.stringify(policy));
  return { root, directory, source, policyPath };
}

const policy = {
  schema_version: 1,
  tasks: {
    [repository]: {
      [project]: {
        required: ["REQUIRED_KEY"],
        allowed: ["OPTIONAL_KEY"],
        aliases: { REQUIRED_KEY: "STORED_KEY_PRIMARY" },
      },
    },
  },
};

test("scoped task bindings map only declared names and validated aliases", async () => {
  const f = await fixture({ required: "REQUIRED_KEY\n", allowed: "OPTIONAL_KEY\n" }, policy);
  try {
    const plan = await resolveTaskSecretPlan(f.source, f.policyPath, repository, project);
    assert.deepEqual(plan.slots, [
      {
        slot: "AW_TASK_SECRET_SLOT_01",
        logical_name: "OPTIONAL_KEY",
        stored_name: "OPTIONAL_KEY",
        required: false,
      },
      {
        slot: "AW_TASK_SECRET_SLOT_02",
        logical_name: "REQUIRED_KEY",
        stored_name: "STORED_KEY_PRIMARY",
        required: true,
      },
    ]);
    assert.equal(
      validateTaskSecretSlots(plan, {
        AW_TASK_SECRET_SLOT_02: "required-secret",
      }),
      2
    );
    assert.throws(() => validateTaskSecretSlots(plan, {}), /required task Secret/);
    assert.doesNotMatch(JSON.stringify(plan), /required-secret/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("scoped task bindings reject unauthorized and duplicated declarations", async () => {
  const f = await fixture({ required: "OUTSIDE_POLICY\n", allowed: "" }, policy);
  try {
    await assert.rejects(
      resolveTaskSecretPlan(f.source, f.policyPath, repository, project),
      /central policy ceiling/
    );
    await writeFile(join(f.directory, ".secrets.required"), "REQUIRED_KEY\nREQUIRED_KEY\n");
    await assert.rejects(
      resolveTaskSecretPlan(f.source, f.policyPath, repository, project),
      /duplicate/
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("scoped task bindings reject symlinked declarations before reading", async () => {
  const f = await fixture({ required: "REQUIRED_KEY\n", allowed: "" }, policy);
  try {
    await rm(join(f.directory, ".secrets.required"));
    await symlink(join(f.directory, ".secrets.allowed"), join(f.directory, ".secrets.required"));
    await assert.rejects(
      resolveTaskSecretPlan(f.source, f.policyPath, repository, project),
      /bounded regular file/
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("scoped task bindings fail closed for forged or overlapping slot plans", () => {
  const base = {
    schema_version: 1 as const,
    repository,
    project,
    slots: [
      {
        slot: "AW_TASK_SECRET_SLOT_01",
        logical_name: "REQUIRED_KEY",
        stored_name: "STORED_KEY_PRIMARY",
        required: true,
      },
    ],
  };
  assert.throws(
    () =>
      validateTaskSecretSlots(
        { ...base, slots: [{ ...base.slots[0]!, slot: "AW_TASK_SECRET_SLOT_02" }] },
        {
          AW_TASK_SECRET_SLOT_02: "value",
        }
      ),
    /invalid binding/
  );
  assert.throws(
    () =>
      validateTaskSecretSlots(
        { ...base, slots: [base.slots[0]!, base.slots[0]!] },
        {
          AW_TASK_SECRET_SLOT_01: "value",
        }
      ),
    /invalid binding/
  );
});

test("resolve CLI reads exported Actions Variables while keeping Secret values out of its plan", async () => {
  const root = await mkdtemp(join(tmpdir(), "aw-task-variable-resolve-"));
  try {
    const source = join(root, "source");
    const directory = join(source, "projects", "FongapCDN");
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, ".secrets.required"),
      "CLOUDFLARE_ACCOUNT_ID\\nCLOUDFLARE_API_TOKEN\\n"
    );
    await writeFile(join(directory, ".secrets.allowed"), "");
    const output = join(root, "github-output");
    const baseEnv = {
      RUNNER_TEMP: root,
      AW_SOURCE_DIR: source,
      TASK_SOURCE_REPOSITORY: "fongap-labs/internal-vault",
      PROJECT: "FongapCDN",
      GITHUB_OUTPUT: output,
    };
    const run = (overrides: Record<string, string> = {}) =>
      spawnSync(process.execPath, ["scripts/resolve-task-secret-plan.ts", "resolve"], {
        cwd: process.cwd(),
        env: { ...baseEnv, ...overrides },
        encoding: "utf8",
      });

    const missing = run();
    assert.equal(missing.status, 77);
    assert.match(missing.stderr, /Required task Variable is unavailable/);

    const provided = run({ CLOUDFLARE_ACCOUNT_ID_PRIMARY: "synthetic-test-account" });
    assert.equal(provided.status, 0, provided.stderr);
    const planText = await readFile(join(root, "action-worker-task-secret-plan.json"), "utf8");
    const plan = JSON.parse(planText) as {
      slots: Array<{ logical_name: string; stored_name: string; kind?: string; required: boolean }>;
    };
    assert.deepEqual(
      plan.slots.map(({ logical_name, stored_name, kind, required }) => ({
        logical_name,
        stored_name,
        kind: kind ?? "secret",
        required,
      })),
      [
        {
          logical_name: "CLOUDFLARE_ACCOUNT_ID",
          stored_name: "CLOUDFLARE_ACCOUNT_ID_PRIMARY",
          kind: "variable",
          required: true,
        },
        {
          logical_name: "CLOUDFLARE_API_TOKEN",
          stored_name: "CLOUDFLARE_API_TOKEN_PRIMARY",
          kind: "secret",
          required: true,
        },
      ]
    );
    assert.doesNotMatch(planText, /synthetic-test-account/);
    assert.doesNotMatch(provided.stdout, /synthetic-test-account/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
