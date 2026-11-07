import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parse } from "yaml";
import {
  hasVerifiedAsset,
  requiredAttestations,
  verifyArguments,
} from "../scripts/verify-release-attestations.ts";
import { parseReleaseBuildManifest } from "../scripts/validate-release-build-request.ts";

const sample = parseReleaseBuildManifest({
  schema_version: 1,
  artifact_name: "example-release",
  target_repository: "fongap-labs/example",
  release_key: "example",
  release_name: "Example",
  release_notes: "",
  license_expression: "Apache-2.0",
  node_version_file: "",
  python_version_file: "",
  sbom_asset: "",
  builds: [
    {
      id: "portable",
      runner_profile: "linux-standard",
      target: "portable",
      script: "scripts/build.mjs",
      assets: ["app.zip", "app.tgz"],
      attest_asset: "app.zip",
    },
  ],
});

test("formal releases require attestation for every asset; legacy betas may opt out", () => {
  assert.deepEqual(requiredAttestations(sample, "1.2.3").map((x) => x.asset), [
    "app.zip",
    "app.tgz",
  ]);
  const unprotected = {
    ...sample,
    builds: sample.builds.map((build) => ({ ...build, attest_asset: "" })),
  };
  assert.throws(() => requiredAttestations(unprotected, "1.2.3"), /does not declare attestation/);
  assert.deepEqual(requiredAttestations(unprotected, "1.2.3-beta.1"), []);
});

test("verification binds identity to central workflow and source digest", () => {
  const sha = "a".repeat(40);
  assert.deepEqual(verifyArguments("/tmp/app.zip", "fongap-labs/action-worker", sha), [
    "attestation",
    "verify",
    "/tmp/app.zip",
    "--repo",
    "fongap-labs/action-worker",
    "--signer-workflow",
    "fongap-labs/action-worker/.github/workflows/release-app.yml",
    "--source-digest",
    sha,
    "--format",
    "json",
  ]);
  assert.throws(() => verifyArguments("app", "bad/../repo", sha));
});

test("verified evidence must name the exact file and expected SHA256", () => {
  const digest = "b".repeat(64);
  const bundle = [
    { verificationResult: { statement: { subject: [{ name: "app.zip", digest: { sha256: digest } }] } } },
  ];
  assert.equal(hasVerifiedAsset(bundle, "app.zip", digest), true);
  assert.equal(hasVerifiedAsset(bundle, "app.tgz", digest), false);
  assert.equal(hasVerifiedAsset(bundle, "app.zip", "c".repeat(64)), false);
  assert.equal(hasVerifiedAsset({ verificationResult: bundle }, "app.zip", digest), false);
});

test("trusted package job must verify provenance after build/attest but before upload", async () => {
  const workflow = parse(await readFile(".github/workflows/release-app.yml", "utf8")) as {
    jobs: Record<string, { needs?: string[]; steps?: { name?: string; run?: string }[] }>;
  };
  const pkg = workflow.jobs.package;
  assert.ok(pkg);
  assert.deepEqual(pkg.needs, ["prepare", "build", "attest"]);
  const steps = pkg.steps ?? [];
  const verifyIndex = steps.findIndex((x) => x.name === "Verify build provenance and signer before packaging");
  const packageIndex = steps.findIndex((x) => x.name === "Build manifest and provenance");
  assert.ok(verifyIndex >= 0 && packageIndex > verifyIndex);
  assert.match(steps[verifyIndex]?.run ?? "", /verify-release-attestations.ts/);
});
