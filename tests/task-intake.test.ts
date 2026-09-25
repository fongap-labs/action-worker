import assert from "node:assert/strict";
import { test } from "node:test";
import { scanTaskSources } from "../scripts/intake-task-sources.ts";

const headSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const beforeSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function encoded(value: unknown): { encoding: "base64"; content: string } {
  return {
    encoding: "base64",
    content: Buffer.from(JSON.stringify(value), "utf8").toString("base64"),
  };
}

function sourceWithStatus(state = "") {
  const repository = "fongap-labs/tasks";
  const manifestPath = `repos/${repository}/contents/.github/task-source.json?ref=${headSha}`;
  return {
    repository,
    source: {
      async exists(path: string): Promise<boolean> {
        return path === manifestPath;
      },
      async get(path: string): Promise<unknown> {
        if (path === `repos/${repository}`) {
          return { default_branch: "main" };
        }
        if (path === `repos/${repository}/commits/main`) {
          return { sha: headSha, parents: [{ sha: beforeSha }] };
        }
        if (path === manifestPath) {
          return encoded({ schema_version: "1", push: true, schedules: [] });
        }
        if (path === `repos/${repository}/commits/${headSha}/status`) {
          return {
            statuses: state
              ? [{ context: "Task Source", state }]
              : [],
          };
        }
        throw new Error(`unexpected path: ${path}`);
      },
    },
  };
}

test("task intake dispatches an unprocessed push-enabled default head", async () => {
  const { repository, source } = sourceWithStatus();
  const dispatched: Array<{ repository: string; before: string; head: string }> = [];
  const result = await scanTaskSources(
    { [repository]: ["task"] },
    source,
    async (repo, before, head) => {
      dispatched.push({ repository: repo, before, head });
    },
  );

  assert.deepEqual(dispatched, [{ repository, before: beforeSha, head: headSha }]);
  assert.deepEqual(result, {
    repositories: 1,
    push_enabled: 1,
    dispatched: 1,
    in_flight: 0,
    already_processed: 0,
  });
});

test("task intake skips pending and processed heads", async () => {
  for (const [state, field] of [["pending", "in_flight"], ["success", "already_processed"]] as const) {
    const { repository, source } = sourceWithStatus(state);
    let dispatches = 0;
    const result = await scanTaskSources(
      { [repository]: ["task"] },
      source,
      async () => { dispatches += 1; },
    );
    assert.equal(dispatches, 0);
    assert.equal(result[field], 1);
  }
});

test("task intake ignores manifests without push intent", async () => {
  const repository = "fongap-labs/tasks";
  const manifestPath = `repos/${repository}/contents/.github/task-source.json?ref=${headSha}`;
  let statusReads = 0;
  const result = await scanTaskSources(
    { [repository]: ["task"] },
    {
      async exists(path: string): Promise<boolean> {
        return path === manifestPath;
      },
      async get(path: string): Promise<unknown> {
        if (path === `repos/${repository}`) return { default_branch: "main" };
        if (path === `repos/${repository}/commits/main`) {
          return { sha: headSha, parents: [{ sha: beforeSha }] };
        }
        if (path === manifestPath) {
          return encoded({ schema_version: "1", schedules: [] });
        }
        if (path.endsWith("/status")) {
          statusReads += 1;
          return { statuses: [] };
        }
        throw new Error(`unexpected path: ${path}`);
      },
    },
    async () => {
      throw new Error("dispatch should not run");
    },
  );
  assert.equal(statusReads, 0);
  assert.equal(result.push_enabled, 0);
  assert.equal(result.dispatched, 0);
});
