import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  collectPublicConsumers,
  compatibilityRegressions,
  profilesFromManifest,
  type JsonGetter,
} from "../scripts/downstream-compatibility.ts";
import { parseRunnerPolicy } from "../scripts/runner-policy.ts";

const baseline = parseRunnerPolicy(JSON.parse(await readFile("policies/runner.json", "utf8")));
const manifest = {
  schema_version: 1,
  root: "packages",
  artifact_name: "desktop-build",
  target_repository: "fongap-labs/example",
  release_key: "desktop",
  release_name: "Desktop",
  release_notes: "",
  license_expression: "Apache-2.0",
  node_version_file: "",
  python_version_file: "",
  sbom_asset: "",
  builds: [{
    id: "linux",
    runner_profile: "linux-standard",
    target: "portable",
    script: "build.mjs",
    assets: ["example.zip"],
    attest_asset: "example.zip",
  }],
};

test("central runner policy modifications cannot silently break published consumers", () => {
  const consumers = profilesFromManifest("fongap-labs/example", "projects/desktop/release.manifest.json", manifest);
  assert.deepEqual(compatibilityRegressions(consumers, baseline, baseline), []);
  const candidate = parseRunnerPolicy({
    schema_version: 1,
    profiles: {
      ...baseline.profiles,
      "linux-standard": {
        ...baseline.profiles["linux-standard"],
        enabled: false,
      },
    },
  });
  assert.match(compatibilityRegressions(consumers, baseline, candidate)[0] ?? "", /became unavailable/);
});

test("public repo discovery inspects root and projects manifests read-only", async () => {
  const requests: string[] = [];
  const getJson: JsonGetter = async (url) => {
    requests.push(url);
    if (url.includes("/orgs/")) return [{ full_name: "fongap-labs/example", default_branch: "main" }];
    if (url.includes("/git/trees/")) return {
      truncated: false,
      tree: [{ path: "projects/desktop/release.manifest.json", type: "blob" }],
    };
    if (url.includes("/contents/")) return {
      encoding: "base64",
      content: Buffer.from(JSON.stringify(manifest)).toString("base64"),
    };
    throw new Error("Unexpected GitHub API URL");
  };
  const consumers = await collectPublicConsumers("fongap-labs", getJson);
  assert.equal(consumers.length, 1);
  assert.equal(consumers[0]?.runner_profile, "linux-standard");
  assert.equal(requests.length, 3);
});
