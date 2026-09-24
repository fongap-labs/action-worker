import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseCargoPackageVersion,
  parseCargoWorkspaceVersion,
  parseReleaseBuildPolicy,
  parseReleaseBuildRequest,
} from "../scripts/validate-release-build-request.ts";

const policy = {
  schema_version: 1,
  repositories: {
    "fongap-labs/app-source": {
      artifact_name: "secure-pigeon-release",
      target_repository: "fongap-labs/external-vault",
      release_key: "secure-pigeon",
      release_name: "SecurePigeon",
      release_notes: "SecurePigeon Windows release.",
      license_expression: "LicenseRef-Proprietary",
      node_version_file: "",
      python_version_file: "",
      sbom_asset: "",
      version_source: {
        type: "cargo-workspace",
        path: "projects/SecurePigeon/Cargo.toml",
      },
      builds: [
        {
          id: "x64",
          runner: "windows-latest",
          target: "x86_64-pc-windows-msvc",
          script: ".github/scripts/release-build.ps1",
          assets: ["secure-pigeon-windows-x64.exe"],
          attest_asset: "",
        },
      ],
    },
    "fongap-labs/delta": {
      artifact_name: "delta-release",
      target_repository: "fongap-labs/external-vault",
      release_key: "delta",
      release_name: "Delta",
      release_notes: "Delta Windows portable release.",
      license_expression: "Apache-2.0",
      node_version_file: ".nvmrc",
      python_version_file: ".python-version",
      sbom_asset: "delta-windows-x64-portable.sbom.cdx.json",
      version_source: {
        type: "cargo-package",
        path: "apps/desktop/src-tauri/Cargo.toml",
      },
      builds: [
        {
          id: "windows-portable",
          runner: "windows-latest",
          target: "x86_64-pc-windows-msvc",
          script: ".github/scripts/release-build.ps1",
          assets: ["delta-windows-x64-portable.zip"],
          attest_asset: "delta-windows-x64-portable.zip",
        },
      ],
    },
  },
};

test("release build policy is explicit and repository scoped", () => {
  assert.deepEqual(parseReleaseBuildPolicy(policy), policy);
  assert.throws(() => parseReleaseBuildPolicy({
    ...policy,
    repositories: {
      "fongap-labs/app-source": {
        ...policy.repositories["fongap-labs/app-source"],
        unknown: true,
      },
    },
  }));
});

test("release build policy binds attestation and package assets", () => {
  const delta = policy.repositories["fongap-labs/delta"];
  assert.deepEqual(parseReleaseBuildPolicy(policy).repositories["fongap-labs/delta"], delta);
  assert.throws(() => parseReleaseBuildPolicy({
    ...policy,
    repositories: {
      "fongap-labs/delta": {
        ...delta,
        builds: [{
          ...delta.builds[0],
          attest_asset: "not-produced.zip",
        }],
      },
    },
  }));
  assert.throws(() => parseReleaseBuildPolicy({
    ...policy,
    repositories: {
      "fongap-labs/delta": {
        ...delta,
        sbom_asset: "delta-windows-x64-portable.zip",
      },
    },
  }));
});

test("release build request is immutable-source only", () => {
  const request = {
    schema_version: "1",
    request_id: "release-build-1",
    source_repository: "fongap-labs/app-source",
    source_sha: "a".repeat(40),
    requested_version: "v0.1.0",
  };
  assert.deepEqual(parseReleaseBuildRequest(request), request);
  assert.throws(() => parseReleaseBuildRequest({ ...request, source_sha: "main" }));
});

test("cargo version parsers require stable SemVer", () => {
  assert.equal(
    parseCargoWorkspaceVersion('[workspace]\n\n[workspace.package]\nversion = "0.1.0"\nedition = "2021"\n'),
    "0.1.0",
  );
  assert.equal(
    parseCargoPackageVersion('[package]\nname = "delta-desktop"\nversion = "0.1.0"\n'),
    "0.1.0",
  );
  assert.throws(() => parseCargoWorkspaceVersion('[workspace.package]\nversion = "0.1.0-dev.1"\n'));
  assert.throws(() => parseCargoPackageVersion('[package]\nversion = "0.1.0-rc.1"\n'));
});
