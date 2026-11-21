import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { chooseLinuxManifestCommand } from "../scripts/execute-linux-ci.ts";

const bootstrap = ["bash", "{control_root}/.github/scripts/central-ci.sh", "{target_root}"];
function manifest(command: string[], matrix?: { shard: string[] }) {
  return {
    schema_version: "1",
    operations: {
      ci: {
        jobs: [
          {
            id: "linux",
            runner_profile: "linux-standard",
            command,
            timeout_minutes: 30,
            capability_requests: ["source.read"],
            ...(matrix ? { matrix } : {}),
          },
        ],
      },
    },
  };
}

test("missing legacy script permits only a bounded checked-out Node.js manifest command", () => {
  const root = mkdtempSync(join(tmpdir(), "manifest-linux-"));
  try {
    mkdirSync(join(root, "scripts"));
    writeFileSync(join(root, "scripts", "verify.mjs"), "console.log('ok')\n");
    assert.deepEqual(chooseLinuxManifestCommand(manifest(bootstrap), root), { kind: "bootstrap" });
    assert.deepEqual(
      chooseLinuxManifestCommand(
        manifest(["node", "{target_root}/scripts/verify.mjs", "--ci"]),
        root
      ),
      {
        kind: "node",
        script: join(root, "scripts", "verify.mjs"),
        args: ["--ci"],
        timeoutMs: 1_800_000,
      }
    );
    const choice = chooseLinuxManifestCommand(
      manifest(["node", "{target_root}/scripts/verify.mjs", "--ci"], {
        shard: ["unit", "build"],
      }),
      root,
      "unit"
    );
    assert.equal(choice.kind, "node");
    if (choice.kind === "node") {
      assert.deepEqual(choice.args, ["--ci", "unit"]);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("manifest CI refuses unsafe executables, scripts and undeclared privileges", () => {
  const root = mkdtempSync(join(tmpdir(), "manifest-deny-"));
  try {
    mkdirSync(join(root, "scripts"));
    writeFileSync(join(root, "scripts", "verify.mjs"), "");
    for (const command of [
      ["bash", "-lc", "echo unsafe"],
      ["node", "-e", "console.log(1)"],
      ["node", "{target_root}/../secret.mjs"],
      ["node", "{target_root}/scripts/missing.mjs"],
      ["node", "{control_root}/scripts/verify.mjs"],
    ]) {
      assert.throws(() => chooseLinuxManifestCommand(manifest(command), root));
    }
    assert.throws(
      () => chooseLinuxManifestCommand(manifest(bootstrap), root, "unknown"),
      /bridge bootstrap cannot declare Linux shards/
    );
    assert.throws(
      () =>
        chooseLinuxManifestCommand(
          manifest(["node", "{target_root}/scripts/verify.mjs", "--ci"]),
          root,
          "unknown"
        ),
      /shard was not declared/
    );
    const privileged = manifest(["node", "{target_root}/scripts/verify.mjs"]);
    privileged.operations.ci.jobs[0]?.capability_requests.push("deployment.production");
    assert.throws(
      () => chooseLinuxManifestCommand(privileged, root),
      /additional runner capabilities/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Linux fallback permits only the centrally audited Delta Windows companion", () => {
  const root = mkdtempSync(join(tmpdir(), "manifest-dual-platform-"));
  try {
    mkdirSync(join(root, "scripts"));
    writeFileSync(join(root, "scripts", "verify.mjs"), "console.log('ok')\n");
    const linux = manifest(["node", "{target_root}/scripts/verify.mjs", "--ci"]);
    const windows = {
      id: "windows",
      runner_profile: "windows-standard",
      command: [
        "pwsh",
        "-NoProfile",
        "-File",
        "{central_root}/tests/packs/delta/windows-desktop-ci.ps1",
        "-TargetRoot",
        "{target_root}",
      ],
      timeout_minutes: 90,
      capability_requests: ["source.read"],
    };
    const jobs = linux.operations.ci.jobs as Array<Record<string, unknown>>;
    jobs.push(windows);
    assert.deepEqual(chooseLinuxManifestCommand(linux, root), {
      kind: "node",
      script: join(root, "scripts", "verify.mjs"),
      args: ["--ci"],
      timeoutMs: 1_800_000,
    });
    const altered = { ...windows, capability_requests: ["source.read", "deployment.production"] };
    jobs[1] = altered;
    assert.throws(() => chooseLinuxManifestCommand(linux, root), /at most one audited Windows job/);
    jobs[1] = { ...windows, command: ["pwsh", "-File", "{target_root}/malicious.ps1"] };
    assert.throws(() => chooseLinuxManifestCommand(linux, root), /at most one audited Windows job/);
    jobs[1] = { ...windows, artifacts: [{ name: "private", path: "home" }] };
    assert.throws(() => chooseLinuxManifestCommand(linux, root), /at most one audited Windows job/);
    jobs[1] = windows;
    jobs.push({ ...windows, id: "other-platform" });
    assert.throws(() => chooseLinuxManifestCommand(linux, root), /at most one audited Windows job/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
