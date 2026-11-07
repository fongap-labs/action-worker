import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  allowPrivateWindowsNumericDiagnostic,
  resolveCiCapabilities,
  resolveLinuxShards,
} from "../scripts/resolve-ci-capabilities.ts";

function manifestWith(linuxJob: Record<string, unknown>, extraJobs: unknown[] = []): unknown {
  return {
    schema_version: "1",
    operations: {
      ci: {
        jobs: [
          {
            id: "linux",
            runner_profile: "linux-standard",
            command: ["bash", "{control_root}/.github/scripts/central-ci.sh", "{target_root}"],
            timeout_minutes: 60,
            capability_requests: ["source.read"],
            ...linuxJob,
          },
          ...extraJobs,
        ],
      },
    },
  };
}

test("CI capability resolver validates repository and trusted ref before GitHub access", async () => {
  await assert.rejects(
    resolveCiCapabilities("bad repository", "main", "token"),
    /Invalid repository/
  );
  await assert.rejects(
    resolveCiCapabilities("fongap/example", "../main", "token"),
    /Invalid trusted control ref/
  );
  await assert.rejects(
    resolveCiCapabilities("fongap/example", "main", ""),
    /AW_CONTROL_TOKEN is required/
  );
});

test("Linux CI stays a single unsharded job when the manifest declares no shard matrix", () => {
  assert.deepEqual(resolveLinuxShards(manifestWith({})), ["all"]);
});

test("Linux CI stays unsharded when the manifest has no ci operation", () => {
  assert.deepEqual(
    resolveLinuxShards({
      schema_version: "1",
      operations: {
        deploy: {
          jobs: [
            {
              id: "deploy",
              runner_profile: "production-deploy",
              command: ["bash", "{control_root}/deploy.sh"],
              timeout_minutes: 10,
              capability_requests: ["source.read"],
            },
          ],
        },
      },
    }),
    ["all"]
  );
});

test("Linux CI fans out over the shard values of the linux job in declaration order", () => {
  assert.deepEqual(
    resolveLinuxShards(manifestWith({ matrix: { shard: ["checks", "python", "rust-app"] } })),
    ["checks", "python", "rust-app"]
  );
});

test("only the linux job of the ci operation defines shards", () => {
  const windows = {
    id: "windows",
    runner_profile: "windows-build",
    command: ["pwsh", "-File", "{control_root}/.github/scripts/central-ci.ps1"],
    timeout_minutes: 30,
    capability_requests: ["source.read"],
    matrix: { shard: ["ignored"] },
  };
  assert.deepEqual(resolveLinuxShards(manifestWith({}, [windows])), ["all"]);
});

test("shard declarations fail closed instead of silently running fewer jobs", () => {
  assert.throws(
    () => resolveLinuxShards(manifestWith({ matrix: { shard: ["a"], target: ["x64"] } })),
    /supports only the shard key/
  );
  assert.throws(
    () => resolveLinuxShards(manifestWith({ matrix: { target: ["x64"] } })),
    /supports only the shard key/
  );
  assert.throws(
    () => resolveLinuxShards(manifestWith({ matrix: { shard: ["Bad_Name"] } })),
    /Invalid Linux CI shard name/
  );
  assert.throws(
    () => resolveLinuxShards(manifestWith({ matrix: { shard: ["all"] } })),
    /Invalid Linux CI shard name/
  );
  assert.throws(
    () =>
      resolveLinuxShards(
        manifestWith({ matrix: { shard: ["a", "b", "c", "d", "e", "f", "g", "h", "i"] } })
      ),
    /more than 8 shards/
  );
  assert.throws(
    () => resolveLinuxShards({ schema_version: "1", operations: {}, extra: true }),
    /Execution contract keys are invalid/
  );
});

test("private Windows numeric diagnostics are centrally allowed only for private named repositories", () => {
  const policy: unknown = JSON.parse(readFileSync("policies/ci-diagnostics.json", "utf8"));
  assert.equal(allowPrivateWindowsNumericDiagnostic(policy, "fongap-labs/app-source", true), true);
  assert.equal(
    allowPrivateWindowsNumericDiagnostic(policy, "fongap-labs/app-source", false),
    false
  );
  assert.equal(
    allowPrivateWindowsNumericDiagnostic(policy, "fongap-labs/internal-vault", true),
    false
  );
  assert.equal(allowPrivateWindowsNumericDiagnostic(policy, "fongap-labs/unlisted", true), false);
});

test("private Windows numeric diagnostic policy rejects unknown or malformed grants", () => {
  const invalid: unknown[] = [
    null,
    {},
    { schema_version: 2, private_windows_numeric_diagnostics: [] },
    { schema_version: 1, private_windows_numeric_diagnostics: "all" },
    { schema_version: 1, private_windows_numeric_diagnostics: ["bad repository"] },
    {
      schema_version: 1,
      private_windows_numeric_diagnostics: ["fongap-labs/app-source", "fongap-labs/app-source"],
    },
    { schema_version: 1, private_windows_numeric_diagnostics: [], additional_grants: true },
  ];
  for (const value of invalid) {
    assert.throws(
      () => allowPrivateWindowsNumericDiagnostic(value, "fongap-labs/app-source", true),
      /Central CI diagnostic/
    );
  }
});
