import assert from "node:assert/strict";
import { test } from "node:test";
import { discoverFailedRuns, type FailedRunCandidate } from "../scripts/repair-discovery.ts";

const since = "2026-11-20T00:00:00Z";
const head = "a".repeat(40);

function repo(name: string, isPrivate = false) {
  return {
    full_name: `fongap-labs/${name}`,
    owner: { login: "fongap-labs" },
    private: isPrivate,
    archived: false,
    disabled: false,
  };
}

function run(id: number, repository: string, conclusion = "failure") {
  return {
    id,
    repository: { full_name: repository },
    status: "completed",
    conclusion,
    created_at: "2026-11-21T00:01:00Z",
    head_sha: head,
    path: ".github/workflows/test.yml",
  };
}

test("enumerates both public and private installation repositories without a hardcoded list", async () => {
  const paths: string[] = [];
  const candidates: FailedRunCandidate[] = [];
  const originalLog = console.log;
  let logged = false;
  console.log = () => {
    logged = true;
  };
  try {
    const summary = await discoverFailedRuns(
      {
        async get(path) {
          paths.push(path);
          if (path.startsWith("installation/repositories?")) {
            return { total_count: 2, repositories: [repo("gateway"), repo("private-vault", true)] };
          }
          if (path.includes("status=failure")) {
            const name = path.includes("private-vault") ? "private-vault" : "gateway";
            return {
              total_count: 1,
              workflow_runs: [run(name === "gateway" ? 41 : 42, `fongap-labs/${name}`)],
            };
          }
          if (path.includes("status=timed_out")) {
            return { total_count: 0, workflow_runs: [] };
          }
          throw new Error("unexpected read");
        },
      },
      "fongap-labs",
      since,
      (candidate) => {
        candidates.push(candidate);
      }
    );
    assert.deepEqual(summary, { repositories_scanned: 2, failures_found: 2 });
    assert.deepEqual(candidates.map((candidate) => candidate.is_private), [false, true]);
    assert.equal(paths.filter((path) => path.includes("actions/runs")).length, 4);
    assert.equal(logged, false);
  } finally {
    console.log = originalLog;
  }
});

test("pages installation inventory and failure runs without truncating the scan", async () => {
  const inventory = Array.from({ length: 101 }, (_, i) => repo(`repo-${i}`));
  const candidates: FailedRunCandidate[] = [];
  let pages = 0;
  const summary = await discoverFailedRuns(
    {
      async get(path) {
        if (path.startsWith("installation/repositories?")) {
          return {
            total_count: 101,
            repositories: path.endsWith("page=1") ? inventory.slice(0, 100) : inventory.slice(100),
          };
        }
        if (path.includes("status=timed_out")) return { total_count: 0, workflow_runs: [] };
        if (path.includes("/repo-0/actions/runs")) {
          pages += 1;
          const first = path.endsWith("page=1");
          return {
            total_count: 101,
            workflow_runs: Array.from({ length: first ? 100 : 1 }, (_, i) =>
              run(first ? i + 1 : 101, "fongap-labs/repo-0")
            ),
          };
        }
        return { total_count: 0, workflow_runs: [] };
      },
    },
    "fongap-labs",
    since,
    (candidate) => {
      candidates.push(candidate);
    }
  );
  assert.equal(summary.repositories_scanned, 101);
  assert.equal(summary.failures_found, 101);
  assert.equal(candidates.length, 101);
  assert.equal(pages, 2);
});

test("rejects cross-owner installation, duplicate repositories and unstable inventory", async () => {
  for (const repos of [
    [{ ...repo("other"), owner: { login: "outside" } }],
    [repo("same"), repo("same")],
  ]) {
    await assert.rejects(
      discoverFailedRuns(
        {
          async get() {
            return { total_count: repos.length, repositories: repos };
          },
        },
        "fongap-labs",
        since,
        () => undefined
      )
    );
  }
  await assert.rejects(
    discoverFailedRuns(
      {
        async get(path) {
          if (path.endsWith("page=1")) {
            return {
              total_count: 101,
              repositories: Array.from({ length: 100 }, (_, i) => repo(`repo-${i}`)),
            };
          }
          return { total_count: 102, repositories: [repo("last")] };
        },
      },
      "fongap-labs",
      since,
      () => undefined
    ),
    /changed/
  );
});

test("rejects failed-run payloads with mismatched provenance or false success", async () => {
  for (const bad of [
    { conclusion: "success" },
    { status: "in_progress" },
    { head_sha: "not-a-sha" },
    { repository: { full_name: "outside/repository" } },
    { created_at: "2025-01-01T00:00:00Z" },
    { path: "unexpected.yml" },
  ]) {
    let calls = 0;
    await assert.rejects(
      discoverFailedRuns(
        {
          async get(path) {
            if (path.startsWith("installation/")) {
              return { total_count: 1, repositories: [repo("gateway")] };
            }
            if (path.includes("status=failure")) {
              return {
                total_count: 1,
                workflow_runs: [{ ...run(12, "fongap-labs/gateway"), ...bad }],
              };
            }
            return { total_count: 0, workflow_runs: [] };
          },
        },
        "fongap-labs",
        since,
        () => {
          calls += 1;
        }
      )
    );
    assert.equal(calls, 0);
  }
});

test("quota, permissions and incomplete pages fail closed rather than invent a complete scan", async () => {
  for (const inventory of [
    { total_count: 501, repositories: [] },
    { total_count: 2, repositories: [repo("only")] },
    { total_count: 1, repositories: [{ ...repo("one"), private: "unknown" }] },
  ]) {
    await assert.rejects(
      discoverFailedRuns(
        { async get() { return inventory; } },
        "fongap-labs",
        since,
        () => undefined
      )
    );
  }
  await assert.rejects(
    discoverFailedRuns(
      {
        async get(path) {
          if (path.startsWith("installation/")) {
            return { total_count: 1, repositories: [repo("gateway")] };
          }
          throw new Error("HTTP 403 forbidden");
        },
      },
      "fongap-labs",
      since,
      () => undefined
    ),
    /403/
  );
});

test("invalid owner or time range is rejected without touching GitHub", async () => {
  const cases: Array<[string, string]> = [["outside/org", since], ["fongap-labs", "yesterday"]];
  for (const [owner, cutoff] of cases) {
    let reads = 0;
    await assert.rejects(
      discoverFailedRuns(
        { async get() { reads += 1; throw new Error("must not read"); } },
        owner,
        cutoff,
        () => undefined
      ),
      /scope/
    );
    assert.equal(reads, 0);
  }
});
