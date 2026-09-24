import assert from "node:assert/strict";
import { test } from "node:test";
import {
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

test("cargo workspace version parser requires stable SemVer", () => {
  assert.equal(
    parseCargoWorkspaceVersion('[workspace]\n\n[workspace.package]\nversion = "0.1.0"\nedition = "2021"\n'),
    "0.1.0",
  );
  assert.throws(() => parseCargoWorkspaceVersion('[workspace.package]\nversion = "0.1.0-dev.1"\n'));
});
