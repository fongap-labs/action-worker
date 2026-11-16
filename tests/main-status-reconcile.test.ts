import assert from "node:assert/strict";
import { test } from "node:test";
import { reconcileMisattributedMainStatuses } from "../scripts/main-status-reconcile.ts";
import { attestFixtureStatuses } from "./attested-status-fixtures.ts";

const repository = "fongap-labs/ai-gateway";
const controlRepository = "fongap-labs/action-worker";
const mainSha = "a".repeat(40);
const mergedHeadSha = "b".repeat(40);
const runId = 43883134424;
const badRunUrl = `https://github.com/${controlRepository}/actions/runs/${runId}`;
const repairRunUrl = `https://github.com/${controlRepository}/actions/runs/999888`;

function failingGateStatuses() {
  return attestFixtureStatuses(
    {
      statuses: ["PR Governance", "validate-merge"].map((context) => ({
        context,
        state: "failure",
        created_at: "2026-11-16T14:11:45Z",
        target_url: badRunUrl,
        description: "Action Worker governance failed",
      })),
    },
    repository,
    mainSha
  );
}

function reversePr() {
  return {
    state: "closed",
    merged_at: null,
    head: { ref: "main", sha: mainSha },
    base: { ref: "fix/visual" },
    created_at: "2026-11-16T14:11:11Z",
    closed_at: "2026-11-16T14:11:54Z",
  };
}

test("verified merged main is recovered only from a closed reverse PR and a failed governance run", async () => {
  const paths: string[] = [];
  const reader = {
    async get(path: string): Promise<unknown> {
      paths.push(path);
      if (path === `repos/${repository}/commits/${mainSha}/status`) return failingGateStatuses();
      if (path === `repos/${repository}/pulls?state=all&head=fongap-labs%3Amain&per_page=100`)
        return [reversePr()];
      if (path === `repos/${controlRepository}/actions/runs/${runId}`)
        return {
          path: ".github/workflows/handle-pr-dispatch.yml",
          event: "repository_dispatch",
          status: "completed",
          conclusion: "failure",
          created_at: "2026-11-16T14:11:26Z",
        };
      throw new Error(`Unexpected request: ${path}`);
    },
  };
  const published: { context: string; state: string; description: string }[] = [];
  const repaired = await reconcileMisattributedMainStatuses(
    reader,
    repository,
    mainSha,
    mergedHeadSha,
    498,
    controlRepository,
    "test-token",
    repairRunUrl,
    async (request) => {
      published.push(request);
    }
  );
  assert.deepEqual(repaired, ["PR Governance", "validate-merge"]);
  assert.deepEqual(
    published.map(({ context, state }) => ({ context, state })),
    [
      { context: "PR Governance", state: "success" },
      { context: "validate-merge", state: "success" },
    ]
  );
  assert.ok(published.every((item) => item.description.includes("N/A on main")));
  assert.equal(paths.filter((path) => path.endsWith(`actions/runs/${runId}`)).length, 1);
});

test("never recovers an original PR head, unsigned failure, or unrelated reverse PR", async () => {
  const reader = {
    async get(path: string): Promise<unknown> {
      if (path === `repos/${repository}/commits/${mainSha}/status`) return failingGateStatuses();
      if (path.includes("/pulls?")) return [];
      throw new Error(`Unexpected request: ${path}`);
    },
  };
  let published = 0;
  const publish = async () => {
    published += 1;
  };
  const args = [
    repository,
    mainSha,
    mergedHeadSha,
    498,
    controlRepository,
    "test-token",
    repairRunUrl,
  ] as const;
  assert.deepEqual(
    await reconcileMisattributedMainStatuses(
      reader,
      repository,
      mainSha,
      mainSha,
      498,
      controlRepository,
      "test-token",
      repairRunUrl,
      publish
    ),
    []
  );
  assert.deepEqual(await reconcileMisattributedMainStatuses(reader, ...args, publish), []);
  const unsigned = {
    async get(path: string): Promise<unknown> {
      assert.equal(path, `repos/${repository}/commits/${mainSha}/status`);
      return {
        statuses: [
          {
            context: "PR Governance",
            state: "failure",
            description: "unsigned",
            target_url: badRunUrl,
          },
        ],
      };
    },
  };
  assert.deepEqual(await reconcileMisattributedMainStatuses(unsigned, ...args, publish), []);
  assert.equal(published, 0);
});

test("unrelated failed workflow or still-open reverse PR cannot repair merged main statuses", async () => {
  for (const wrongRun of [true, false]) {
    const reader = {
      async get(path: string): Promise<unknown> {
        if (path.endsWith("/status")) return failingGateStatuses();
        if (path.includes("/pulls?"))
          return [{ ...reversePr(), ...(wrongRun ? {} : { state: "open", closed_at: null }) }];
        if (path.endsWith(`actions/runs/${runId}`))
          return {
            path: wrongRun
              ? ".github/workflows/intake.yml"
              : ".github/workflows/handle-pr-dispatch.yml",
            event: "repository_dispatch",
            status: "completed",
            conclusion: "failure",
            created_at: "2026-11-16T14:11:26Z",
          };
        throw new Error(`Unexpected request: ${path}`);
      },
    };
    let writes = 0;
    assert.deepEqual(
      await reconcileMisattributedMainStatuses(
        reader,
        repository,
        mainSha,
        mergedHeadSha,
        498,
        controlRepository,
        "test-token",
        repairRunUrl,
        async () => {
          writes += 1;
        }
      ),
      []
    );
    assert.equal(writes, 0);
  }
});
