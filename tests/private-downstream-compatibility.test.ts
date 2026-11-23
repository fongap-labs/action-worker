import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  collectPrivateConsumers,
  privateCompatibilityFailures,
} from "../scripts/private-downstream-compatibility.ts";
import { parseRunnerPolicy, resolveRunnerProfile } from "../scripts/runner-policy.ts";

const runnerPolicy = parseRunnerPolicy(JSON.parse(await readFile("policies/runner.json", "utf8")));

const releaseManifest = {
  schema_version: 1,
  artifact_name: "example-artifact",
  root: "packages",
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
      id: "win",
      runner_profile: "windows-build",
      target: "x86_64-pc-windows-msvc",
      script: "example/build.ps1",
      assets: ["example.zip"],
      attest_asset: "example.zip",
    },
  ],
};

test("trusted read-only private inventory discovers only installed private manifests", async () => {
  const calls: string[] = [];
  const json = async (url: string): Promise<unknown> => {
    calls.push(url);
    if (url.includes("/installation/repositories")) {
      return {
        repositories: [
          { full_name: "fongap-labs/private-app", default_branch: "main", private: true },
          { full_name: "fongap-labs/public-app", default_branch: "main", private: false },
        ],
      };
    }
    if (url.includes("/git/trees/")) {
      return {
        truncated: false,
        tree: [{ path: "projects/example/release.manifest.json", type: "blob" }],
      };
    }
    return {
      encoding: "base64",
      content: Buffer.from(JSON.stringify(releaseManifest)).toString("base64"),
    };
  };
  const scan = await collectPrivateConsumers(json);
  assert.equal(scan.repositories, 1);
  assert.equal(scan.consumers.length, 1);
  assert.equal(scan.consumers[0]?.runner_profile, "windows-build");
  assert.deepEqual(privateCompatibilityFailures(scan, runnerPolicy), []);
  assert.equal(calls.filter((url) => url.includes("/git/trees/")).length, 1);
});

test("private audit reports anonymous fingerprints, not private identities", () => {
  const scan = {
    repositories: 1,
    consumers: [
      {
        repository: "fongap-labs/secret",
        path: "projects/private/release.manifest.json#win",
        runner_profile: "production-deploy",
      },
    ],
  };
  const failures = privateCompatibilityFailures(scan, runnerPolicy);
  assert.equal(failures.length, 1);
  assert.match(failures[0] ?? "", /^[0-9a-f]{12}$/);
  assert.doesNotMatch(failures[0] ?? "", /private|secret/i);
});

test("private inventory refuses truncated trees rather than silently claiming coverage", async () => {
  await assert.rejects(
    collectPrivateConsumers(async (url) =>
      url.includes("/installation/repositories")
        ? {
            repositories: [
              { full_name: "fongap-labs/secret", default_branch: "main", private: true },
            ],
          }
        : { truncated: true, tree: [] }
    ),
    /truncated/
  );
});

test("reserved Chromium build profile does not break private inventory but cannot release", () => {
  const profile = runnerPolicy.profiles["windows-chromium-build"];
  assert.ok(profile);
  assert.equal(profile.enabled, false);
  assert.deepEqual(profile.fallback_profiles, []);

  const scan = {
    repositories: 1,
    consumers: [
      {
        repository: "fongap-labs/private-app",
        path: "projects/browser/release.manifest.json#windows-x64",
        runner_profile: "windows-chromium-build",
      },
    ],
  };
  assert.deepEqual(privateCompatibilityFailures(scan, runnerPolicy), []);
  assert.throws(
    () => resolveRunnerProfile(runnerPolicy, "windows-chromium-build"),
    /no enabled backend/
  );
});

test("private inventory still rejects missing runners and reserved profiles with wrong trust", () => {
  const scan = {
    repositories: 1,
    consumers: [
      {
        repository: "fongap-labs/private-app",
        path: "projects/browser/release.manifest.json#windows-x64",
        runner_profile: "unconfigured-build",
      },
      {
        repository: "fongap-labs/private-app",
        path: "projects/backend/deploy.json",
        runner_profile: "windows-chromium-build",
      },
    ],
  };
  assert.equal(privateCompatibilityFailures(scan, runnerPolicy).length, 2);
});

test("disabled runners with a fallback still must resolve an enabled compatible backend", () => {
  const profiles = {
    ...runnerPolicy.profiles,
    "windows-chromium-build": {
      ...runnerPolicy.profiles["windows-chromium-build"],
      enabled: false,
      fallback_profiles: ["trusted-deploy"],
    },
  };
  // A fallback crossing trust domains remains forbidden by the policy parser.
  assert.throws(
    () => parseRunnerPolicy({ schema_version: 1, profiles }),
    /cannot cross trust domains/
  );

  const policy = parseRunnerPolicy({
    schema_version: 1,
    profiles: {
      ...runnerPolicy.profiles,
      "windows-chromium-build": {
        ...runnerPolicy.profiles["windows-chromium-build"],
        enabled: false,
        fallback_profiles: ["windows-build"],
      },
      "windows-build": {
        ...runnerPolicy.profiles["windows-build"],
        enabled: false,
      },
    },
  });
  const scan = {
    repositories: 1,
    consumers: [
      {
        repository: "fongap-labs/private-app",
        path: "projects/browser/release.manifest.json#windows-x64",
        runner_profile: "windows-chromium-build",
      },
    ],
  };
  assert.equal(privateCompatibilityFailures(scan, policy).length, 1);
});
