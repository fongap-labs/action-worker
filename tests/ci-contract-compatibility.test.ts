import assert from "node:assert/strict";
import { test } from "node:test";
import { type ReadJson, scanInstalledCiContracts } from "../scripts/ci-contract-compatibility.ts";

function makeJob(id: string) {
  return {
    id,
    runner_profile: "linux-standard",
    command: ["./test.sh"],
    timeout_minutes: 10,
    capability_requests: [],
  };
}
function manifest(...ids: string[]) {
  return { schema_version: "1", operations: { ci: { jobs: ids.map(makeJob) } } };
}
function encode(value: unknown) {
  return { encoding: "base64", content: Buffer.from(JSON.stringify(value)).toString("base64") };
}
const repos = [
  { full_name: "fongap-labs/public-app", default_branch: "main", archived: false, private: false },
  { full_name: "fongap-labs/private-app", default_branch: "main", archived: false, private: true },
  { full_name: "fongap-labs/archived-app", default_branch: "main", archived: true, private: true },
];
function fixture(values: Record<string, unknown>): ReadJson {
  return async (path) => {
    if (path.startsWith("installation/repositories")) {
      return { total_count: repos.length, repositories: repos };
    }
    const match = path.match(/^repos\/([^/]+\/[^/]+)\/contents\//);
    assert.ok(match, "only installed repository manifests may be queried");
    return values[match[1]!] ?? null;
  };
}

test("compatibility inventory checks all authorized active public and private manifests", async () => {
  const result = await scanInstalledCiContracts(
    fixture({
      "fongap-labs/public-app": encode(manifest("linux", "windows")),
      "fongap-labs/private-app": encode(manifest("linux")),
    })
  );
  assert.deepEqual(result, {
    repositories: 3,
    active: 2,
    archived: 1,
    manifests: 2,
    incompatible: 0,
  });
});

test("old unscheduled downstream job IDs block a central CI contract change", async () => {
  // The historical migration condition: the dispatcher supports only Linux and Windows.
  const result = await scanInstalledCiContracts(
    fixture({
      "fongap-labs/private-app": encode(manifest("linux", "security-regression", "win7-compat")),
    })
  );
  assert.equal(result.incompatible, 1);
  assert.deepEqual(Object.keys(result), [
    "repositories",
    "active",
    "archived",
    "manifests",
    "incompatible",
  ]);
});

test("missing manifest keeps default Linux; invalid manifest counts as incompatible", async () => {
  const absent = await scanInstalledCiContracts(fixture({}));
  assert.equal(absent.manifests, 0);
  assert.equal(absent.incompatible, 0);
  const bad = await scanInstalledCiContracts(
    fixture({ "fongap-labs/private-app": { encoding: "base64", content: "%%%" } })
  );
  assert.equal(bad.incompatible, 1);
});

test("partial inventory, duplicate identity and unreadable contents fail closed", async () => {
  await assert.rejects(
    scanInstalledCiContracts(async () => ({ total_count: 3, repositories: [] })),
    /incomplete/
  );
  await assert.rejects(
    scanInstalledCiContracts(async () => ({ total_count: 1, repositories: [repos[0], repos[0]] })),
    /invalid/
  );
  await assert.rejects(
    scanInstalledCiContracts(async () => {
      throw new Error("403");
    }),
    /403/
  );
});

test("truncated or inconsistent pagination never reports a successful inventory", async () => {
  let page = 0;
  await assert.rejects(
    scanInstalledCiContracts(async () => {
      page++;
      return {
        total_count: page === 1 ? 101 : 99,
        repositories: Array.from({ length: 100 }, (_, index) => ({
          full_name: "fongap-labs/repo-" + index,
          default_branch: "main",
          archived: true,
          private: true,
        })),
      };
    }),
    /changed/
  );
});
