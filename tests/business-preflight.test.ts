import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { inspectBusinessProject, parseBusinessChecks } from "../scripts/business-preflight.ts";
import { parseRunnerPolicy } from "../scripts/runner-policy.ts";

const runnerPolicy = parseRunnerPolicy(JSON.parse(await readFile("policies/runner.json", "utf8")));

test("optional business checks are strictly declared and contain no shell", () => {
  assert.deepEqual(parseBusinessChecks(undefined), []);
  assert.deepEqual(
    parseBusinessChecks({
      schema_version: 1,
      checks: [{ id: "unit", command: "npm", args: ["test"], mode: "full" }],
    }).map((x) => x.id),
    ["unit"]
  );
  for (const check of [
    { id: "unit", command: "sh", args: ["-c", "curl example"], mode: "full" },
    { id: "unit", command: "npm", args: ["test"], mode: "prod" },
    { id: "unit", command: "npm", args: ["test\nsecret"], mode: "full" },
  ]) {
    assert.throws(() => parseBusinessChecks({ schema_version: 1, checks: [check] }));
  }
});

test("business preflight checks product-owned scripts and central sandbox policy", async () => {
  const root = await mkdtemp(join(tmpdir(), "aw-business-"));
  try {
    await mkdir(join(root, "projects", "desktop"), { recursive: true });
    await mkdir(join(root, "packages", "desktop"), { recursive: true });
    const file = join(root, "projects", "desktop", "release.manifest.json");
    const manifest = {
      schema_version: 1,
      root: "packages",
      artifact_name: "desktop-release",
      target_repository: "fongap-labs/desktop",
      release_key: "desktop",
      release_name: "Desktop",
      release_notes: "",
      license_expression: "Apache-2.0",
      node_version_file: "",
      python_version_file: "",
      sbom_asset: "",
      builds: [
        {
          id: "linux",
          runner_profile: "linux-standard",
          target: "portable",
          script: "desktop/build.mjs",
          acceptance_script: "desktop/verify.mjs",
          assets: ["desktop.tgz"],
          attest_asset: "desktop.tgz",
        },
      ],
    };
    await writeFile(file, JSON.stringify(manifest));
    await writeFile(join(root, "packages", "desktop", "build.mjs"), "");
    await writeFile(join(root, "packages", "desktop", "verify.mjs"), "");
    assert.deepEqual((await inspectBusinessProject(root, runnerPolicy)).files, [
      join("projects", "desktop", "release.manifest.json"),
    ]);
    await rm(join(root, "packages", "desktop", "verify.mjs"));
    await assert.rejects(inspectBusinessProject(root, runnerPolicy), /Missing release script/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
