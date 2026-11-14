import assert from "node:assert/strict";
import { test } from "node:test";
import { inspectPrivateCiPlan } from "../scripts/private-ci-plan.ts";

const linux = {
  id: "linux",
  runner_profile: "linux-standard",
  command: ["bash", "{control_root}/.github/scripts/central-ci.sh", "{target_root}"],
  timeout_minutes: 180,
  capability_requests: ["source.read"],
};
const windows = {
  id: "windows",
  runner_profile: "windows-build",
  command: ["pwsh", "-File", "{control_root}/.github/scripts/central-ci.ps1", "-TargetRoot", "{target_root}"],
  timeout_minutes: 90,
  capability_requests: ["source.read"],
};
const manifest = (jobs: unknown[]) => ({
  schema_version: "1",
  operations: { ci: { jobs } },
});

test("trusted source CI uses all approved Linux shards and the declared Windows script", () => {
  const plan = inspectPrivateCiPlan(
    manifest([{ ...linux, matrix: { shard: ["checks", "python", "rust-crates"] } }, windows]),
    true
  );
  assert.deepEqual(plan, {
    linux_shards: ["checks", "python", "rust-crates"],
    has_windows: true,
  });
});

test("a repository without a manifest retains its full Linux job", () => {
  assert.deepEqual(inspectPrivateCiPlan(undefined, false), {
    linux_shards: ["all"],
    has_windows: false,
  });
});

test("missing Windows runners or unsupported job ids fail closed", () => {
  assert.throws(() => inspectPrivateCiPlan(manifest([linux, windows]), false));
  assert.throws(() => inspectPrivateCiPlan(manifest([linux]), true));
  assert.throws(() =>
    inspectPrivateCiPlan(manifest([linux, { ...linux, id: "unmapped-test" }]), false)
  );
  assert.throws(() => inspectPrivateCiPlan(manifest([windows]), true));
});
