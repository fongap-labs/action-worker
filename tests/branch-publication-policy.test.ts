import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertBranchDeployEnvironment,
  assertBranchReleaseVersion,
  assertMainPublicationBranch,
  branchReleaseArtifactName,
} from "../scripts/branch-publication-policy.ts";

test("release version and prerelease identity must match the managed branch", () => {
  assert.doesNotThrow(() => assertBranchReleaseVersion("main", "v1.2.3", false));
  assert.doesNotThrow(() => assertBranchReleaseVersion("main", "1.2.3.4", false));
  assert.doesNotThrow(() => assertBranchReleaseVersion("dev", "1.2.3-beta.1", true));
  for (const [branch, version, prerelease] of [
    ["main", "1.2.3-beta.1", true],
    ["main", "1.2.3-beta.1", false],
    ["main", "1.2.3", true],
    ["dev", "1.2.3", false],
    ["dev", "1.2.3-beta.1", false],
    ["dev", "1.2.3-beta.0", true],
    ["dev", "1.2.3-rc.1", true],
    ["other", "1.2.3", false],
  ] as const) {
    assert.throws(() => assertBranchReleaseVersion(branch, version, prerelease));
  }
});

test("production and beta destinations are disjoint; existing execution remains main-only", () => {
  assert.doesNotThrow(() => assertBranchDeployEnvironment("main", "production"));
  assert.doesNotThrow(() => assertBranchDeployEnvironment("dev", "beta"));
  for (const [branch, environment] of [
    ["main", "beta"],
    ["dev", "production"],
    ["main", "staging"],
    ["other", "production"],
    ["dev", ""],
  ] as const) {
    assert.throws(() => assertBranchDeployEnvironment(branch, environment));
  }
  assert.doesNotThrow(() => assertMainPublicationBranch("main"));
  for (const branch of ["dev", "master", ""]) {
    assert.throws(() => assertMainPublicationBranch(branch));
  }
});

test("Beta build artifacts cannot use the formal artifact namespace", () => {
  assert.equal(branchReleaseArtifactName("main", "example"), "example");
  assert.equal(branchReleaseArtifactName("dev", "example"), "dev-beta-example");
  assert.throws(() => branchReleaseArtifactName("main", "dev-beta-example"));
  assert.throws(() => branchReleaseArtifactName("dev", "x".repeat(128)));
});
