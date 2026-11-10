import assert from "node:assert/strict";
import { test } from "node:test";
import { maxCiFailureAttempts } from "../scripts/ci-failure-fingerprint.ts";
import { scanMainCi } from "../scripts/intake-main-ci.ts";
import { GithubHttpError } from "../scripts/github-api.ts";
import { attestFixtureResponseForPath } from "./attested-status-fixtures.ts";

const shaA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const shaB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const shaC = "cccccccccccccccccccccccccccccccccccccccc";
const controlRepository = "fongap-labs/action-worker";
const failureFingerprint = "f".repeat(62);

function transientFailureMarker(retryAfterSeconds = 0): string {
  return `R${retryAfterSeconds}:${failureFingerprint}`;
}

function signedFailures(
  repository: string,
  sha: string,
  runIds: number[],
  createdAt: string,
  retryAfterSeconds = 0
): Record<string, unknown> {
  return attestFixtureResponseForPath(`repos/${repository}/commits/${sha}/status`, {
    statuses: runIds.map((runId, index) => {
      const at = new Date(Date.parse(createdAt) - index * 60_000).toISOString();
      return {
        context: "CI Evidence",
        state: "failure",
        description: transientFailureMarker(retryAfterSeconds),
        target_url: `https://github.com/${controlRepository}/actions/runs/${runId}`,
        created_at: at,
      };
    }),
  }) as Record<string, unknown>;
}

function trustedFailureRun(createdAt: string, id: number): Record<string, unknown> {
  const time = Date.parse(createdAt);
  return {
    id,
    repository: { full_name: controlRepository },
    path: ".github/workflows/central-ci-dispatch.yml",
    head_branch: "main",
    event: "repository_dispatch",
    status: "completed",
    conclusion: "failure",
    run_started_at: new Date(time - 2 * 24 * 60 * 60_000).toISOString(),
    updated_at: new Date(Date.now() + 60_000).toISOString(),
  };
}

function ciFailureReader(repository: string, sha: string, status: unknown) {
  return {
    async get(path: string): Promise<unknown> {
      if (path === `repos/${repository}/commits?per_page=1`) return [{ sha }];
      if (path === `repos/${repository}/commits/${sha}/status`) {
        return attestFixtureResponseForPath(path, status);
      }
      const runMatch = /^repos\/fongap-labs\/action-worker\/actions\/runs\/(\d+)$/.exec(path);
      if (runMatch)
        return trustedFailureRun(
          new Date(Date.now() - 30 * 60_000).toISOString(),
          Number(runMatch[1])
        );
      throw new Error(`unexpected API path: ${path}`);
    },
  };
}

test("central CI intake dispatches only default heads without evidence", async () => {
  const responses = new Map<string, unknown>([
    ["repos/fongap-labs/one/commits?per_page=1", [{ sha: shaA }]],
    [`repos/fongap-labs/one/commits/${shaA}/status`, { statuses: [] }],
    ["repos/fongap-labs/two/commits?per_page=1", [{ sha: shaB }]],
    [
      `repos/fongap-labs/two/commits/${shaB}/status`,
      {
        statuses: [{ context: "CI Evidence", state: "pending" }],
      },
    ],
    ["repos/fongap-labs/three/commits?per_page=1", [{ sha: shaC }]],
    [
      `repos/fongap-labs/three/commits/${shaC}/status`,
      {
        statuses: [{ context: "CI Evidence", state: "success" }],
      },
    ],
  ]);

  const dispatched: Array<{ repository: string; sha: string }> = [];
  const result = await scanMainCi(
    {
      "fongap-labs/one": ["pr"],
      "fongap-labs/two": ["pr"],
      "fongap-labs/three": ["pr"],
    },
    {
      async get(path: string): Promise<unknown> {
        assert.equal(responses.has(path), true, `unexpected API path: ${path}`);
        return attestFixtureResponseForPath(path, responses.get(path));
      },
    },
    async (repository, sha) => {
      dispatched.push({ repository, sha });
    }
  );

  assert.deepEqual(dispatched, [{ repository: "fongap-labs/one", sha: shaA }]);
  assert.deepEqual(result, {
    repositories: 3,
    dispatched: 1,
    in_flight: 1,
    already_processed: 1,
    failed_repositories: [],
  });
});

test("default head lookup rejects an empty or malformed default-branch commit list", async () => {
  const repository = "fongap-labs/example";
  for (const payload of [[], [{}], [{ sha: "not-a-commit-sha" }]]) {
    await assert.rejects(
      scanMainCi(
        { [repository]: ["pr"] },
        {
          async get(path: string): Promise<unknown> {
            assert.equal(path, `repos/${repository}/commits?per_page=1`);
            return payload;
          },
        },
        async () => {
          throw new Error("invalid default HEAD must never dispatch");
        }
      ),
      /default-branch commit list response is invalid|default head SHA is invalid/
    );
  }
});

test("one repository API failure does not prevent later repositories from being reconciled", async () => {
  const failedRepository = "fongap-labs/one";
  const healthyRepository = "fongap-labs/two";
  const dispatched: string[] = [];
  const result = await scanMainCi(
    { [healthyRepository]: ["pr"], [failedRepository]: ["pr"] },
    {
      async get(path: string): Promise<unknown> {
        if (path === `repos/${failedRepository}/commits?per_page=1`) {
          throw new GithubHttpError(503);
        }
        if (path === `repos/${healthyRepository}/commits?per_page=1`) {
          return [{ sha: shaB }];
        }
        if (path === `repos/${healthyRepository}/commits/${shaB}/status`) {
          return { statuses: [] };
        }
        throw new Error(`unexpected API path: ${path}`);
      },
    },
    async (repository) => {
      dispatched.push(repository);
    }
  );

  assert.deepEqual(dispatched, [healthyRepository]);
  assert.deepEqual(result, {
    repositories: 2,
    dispatched: 1,
    in_flight: 0,
    already_processed: 0,
    failed_repositories: [failedRepository],
  });
});

test("a failed dispatch is isolated and later repositories still dispatch", async () => {
  const firstRepository = "fongap-labs/one";
  const secondRepository = "fongap-labs/two";
  const events: string[] = [];
  const result = await scanMainCi(
    { [firstRepository]: ["pr"], [secondRepository]: ["pr"] },
    {
      async get(path: string): Promise<unknown> {
        if (path === `repos/${firstRepository}/commits?per_page=1`) return [{ sha: shaA }];
        if (path === `repos/${firstRepository}/commits/${shaA}/status`) return { statuses: [] };
        if (path === `repos/${secondRepository}/commits?per_page=1`) return [{ sha: shaB }];
        if (path === `repos/${secondRepository}/commits/${shaB}/status`) return { statuses: [] };
        throw new Error(`unexpected API path: ${path}`);
      },
    },
    async (repository) => {
      events.push(`dispatch:${repository}`);
      if (repository === firstRepository) throw new Error("simulated dispatch failure");
    },
    "",
    async (repository) => {
      events.push(`reserve:${repository}`);
    }
  );

  assert.deepEqual(events, [
    `reserve:${firstRepository}`,
    `dispatch:${firstRepository}`,
    `reserve:${secondRepository}`,
    `dispatch:${secondRepository}`,
  ]);
  assert.deepEqual(result.failed_repositories, [firstRepository]);
  assert.equal(result.dispatched, 1);
});

test("central CI intake reserves status before dispatch", async () => {
  const repository = "fongap-labs/example";
  const controlRepository = "fongap-labs/action-worker";
  const events: string[] = [];

  const result = await scanMainCi(
    { [repository]: ["pr"] },
    {
      async get(path: string): Promise<unknown> {
        if (path === `repos/${repository}/commits?per_page=1`) return [{ sha: shaA }];
        if (path === `repos/${repository}/commits/${shaA}/status`) return { statuses: [] };
        throw new Error(`unexpected API path: ${path}`);
      },
    },
    async (target, sha) => {
      events.push(`dispatch:${target}:${sha}`);
    },
    controlRepository,
    async (target, sha) => {
      events.push(`reserve:${target}:${sha}`);
    }
  );

  assert.deepEqual(events, [`reserve:${repository}:${shaA}`, `dispatch:${repository}:${shaA}`]);
  assert.equal(result.dispatched, 1);
});

test("central CI intake honors a recent reservation after the intake run completes", async () => {
  const repository = "fongap-labs/example";
  const controlRepository = "fongap-labs/action-worker";
  let dispatches = 0;
  const updatedAt = new Date().toISOString();

  const result = await scanMainCi(
    { [repository]: ["pr"] },
    {
      async get(path: string): Promise<unknown> {
        if (path === `repos/${repository}/commits?per_page=1`) return [{ sha: shaA }];
        if (path === `repos/${repository}/commits/${shaA}/status`) {
          return attestFixtureResponseForPath(path, {
            statuses: [
              {
                context: "CI Evidence",
                state: "pending",
                updated_at: updatedAt,
                target_url: "https://github.com/fongap-labs/action-worker/actions/runs/45",
              },
            ],
          });
        }
        if (path === "repos/fongap-labs/action-worker/actions/runs/45") {
          return { status: "completed", conclusion: "success" };
        }
        throw new Error(`unexpected API path: ${path}`);
      },
    },
    async () => {
      dispatches += 1;
    },
    controlRepository
  );

  assert.equal(dispatches, 0);
  assert.equal(result.in_flight, 1);
});

test("central CI intake retries an expired pending reservation", async () => {
  const repository = "fongap-labs/example";
  const controlRepository = "fongap-labs/action-worker";
  let dispatches = 0;
  const updatedAt = new Date(Date.now() - 180_000).toISOString();

  const result = await scanMainCi(
    { [repository]: ["pr"] },
    {
      async get(path: string): Promise<unknown> {
        if (path === `repos/${repository}/commits?per_page=1`) return [{ sha: shaA }];
        if (path === `repos/${repository}/commits/${shaA}/status`) {
          return attestFixtureResponseForPath(path, {
            statuses: [
              {
                context: "CI Evidence",
                state: "pending",
                updated_at: updatedAt,
                target_url: "https://github.com/fongap-labs/action-worker/actions/runs/46",
              },
            ],
          });
        }
        if (path === "repos/fongap-labs/action-worker/actions/runs/46") {
          return { status: "completed", conclusion: "failure" };
        }
        throw new Error(`unexpected API path: ${path}`);
      },
    },
    async () => {
      dispatches += 1;
    },
    controlRepository
  );

  assert.equal(dispatches, 1);
  assert.equal(result.dispatched, 1);
});

test("central CI intake rechecks legacy unsigned compatibility evidence", async () => {
  const repository = "fongap-labs/example";
  let dispatches = 0;
  const result = await scanMainCi(
    { [repository]: ["pr"] },
    {
      async get(path: string): Promise<unknown> {
        if (path === `repos/${repository}/commits?per_page=1`) return [{ sha: shaA }];
        return { statuses: [{ context: "ci-evidence", state: "failure" }] };
      },
    },
    async () => {
      dispatches += 1;
    }
  );

  assert.equal(dispatches, 1);
  assert.equal(result.dispatched, 1);
});

test("central CI intake excludes the control repository without hardcoded names", async () => {
  const controlRepository = "fongap-labs/control";
  const businessRepository = "fongap-labs/business";
  const dispatched: string[] = [];
  const result = await scanMainCi(
    {
      [controlRepository]: ["pr"],
      [businessRepository]: ["pr"],
    },
    {
      async get(path: string): Promise<unknown> {
        assert.doesNotMatch(path, /fongap-labs\/control/);
        if (path === `repos/${businessRepository}/commits?per_page=1`) return [{ sha: shaA }];
        return { statuses: [] };
      },
    },
    async (repository) => {
      dispatched.push(repository);
    },
    controlRepository
  );

  assert.deepEqual(dispatched, [businessRepository]);
  assert.equal(result.repositories, 1);
});

test("central CI intake can be limited to the repository of a task source request", async () => {
  const responses = new Map<string, unknown>([
    ["repos/fongap-labs/one/commits?per_page=1", [{ sha: shaA }]],
    [`repos/fongap-labs/one/commits/${shaA}/status`, { statuses: [] }],
  ]);

  const dispatched: Array<{ repository: string; sha: string }> = [];
  const result = await scanMainCi(
    { "fongap-labs/one": ["pr"], "fongap-labs/two": ["pr"] },
    {
      async get(path: string): Promise<unknown> {
        assert.equal(responses.has(path), true, `unexpected API path: ${path}`);
        return attestFixtureResponseForPath(path, responses.get(path));
      },
    },
    async (repository, sha) => {
      dispatched.push({ repository, sha });
    },
    "",
    undefined,
    "fongap-labs/one"
  );

  assert.deepEqual(dispatched, [{ repository: "fongap-labs/one", sha: shaA }]);
  assert.deepEqual(result, {
    repositories: 1,
    dispatched: 1,
    in_flight: 0,
    already_processed: 0,
    failed_repositories: [],
  });
});

test("main CI retries a signed old failure only after trusted control revision changes", async () => {
  const repository = "fongap-labs/example";
  const controlRepository = "fongap-labs/action-worker";
  const targetUrl = "https://github.com/fongap-labs/action-worker/actions/runs/1234";
  const olderControl = "1111111111111111111111111111111111111111";
  const newerControl = "2222222222222222222222222222222222222222";
  const seen: string[] = [];
  const reader = {
    async get(path: string): Promise<unknown> {
      if (path === `repos/${repository}/commits?per_page=1`) return [{ sha: shaA }];
      if (path === `repos/${repository}/commits/${shaA}/status`) {
        return attestFixtureResponseForPath(path, {
          statuses: [
            {
              context: "CI Evidence",
              state: "failure",
              target_url: targetUrl,
              updated_at: new Date().toISOString(),
            },
          ],
        });
      }
      if (path === `repos/${controlRepository}/actions/runs/1234`) {
        return {
          status: "completed",
          conclusion: "failure",
          event: "repository_dispatch",
          head_sha: olderControl,
        };
      }
      throw new Error(`unexpected API path: ${path}`);
    },
  };
  const opts = { [repository]: ["pr"] };
  const rerun = await scanMainCi(
    opts,
    reader,
    async (name) => {
      seen.push(name);
    },
    controlRepository,
    undefined,
    "",
    newerControl
  );
  assert.deepEqual(seen, [repository]);
  assert.equal(rerun.dispatched, 1);

  seen.length = 0;
  const unchanged = await scanMainCi(
    opts,
    reader,
    async (name) => {
      seen.push(name);
    },
    controlRepository,
    undefined,
    "",
    olderControl
  );
  assert.deepEqual(seen, []);
  assert.equal(unchanged.already_processed, 1);

  const missingTrustedVersion = await scanMainCi(
    opts,
    reader,
    async () => {
      throw new Error("Untrusted retry must not dispatch");
    },
    controlRepository
  );
  assert.equal(missingTrustedVersion.already_processed, 1);
});

test("main CI will not retry a signed failure from an untrusted or unfinished run", async () => {
  const repository = "fongap-labs/example";
  const controlRepository = "fongap-labs/action-worker";
  const newerControl = "2222222222222222222222222222222222222222";
  for (const run of [
    { status: "in_progress", conclusion: null, event: "repository_dispatch", head_sha: shaA },
    { status: "completed", conclusion: "success", event: "repository_dispatch", head_sha: shaA },
    { status: "completed", conclusion: "failure", event: "push", head_sha: shaA },
  ]) {
    let dispatches = 0;
    const result = await scanMainCi(
      { [repository]: ["pr"] },
      {
        async get(path: string): Promise<unknown> {
          if (path === `repos/${repository}/commits?per_page=1`) return [{ sha: shaB }];
          if (path === `repos/${repository}/commits/${shaB}/status`) {
            return attestFixtureResponseForPath(path, {
              statuses: [
                {
                  context: "CI Evidence",
                  state: "failure",
                  target_url: "https://github.com/fongap-labs/action-worker/actions/runs/1234",
                },
              ],
            });
          }
          if (path === `repos/${controlRepository}/actions/runs/1234`) return run;
          throw new Error(`unexpected API path: ${path}`);
        },
      },
      async () => {
        dispatches += 1;
      },
      controlRepository,
      undefined,
      "",
      newerControl
    );
    assert.equal(result.already_processed, 1);
    assert.equal(dispatches, 0);
  }
});

test("central CI automatically retries a transient fingerprint only within its three-run budget", async () => {
  const repository = "fongap-labs/example";
  for (const attempts of [1, 2, maxCiFailureAttempts]) {
    let dispatches = 0;
    const status = signedFailures(
      repository,
      shaA,
      Array.from({ length: attempts }, (_, index) => 700 + index),
      new Date(Date.now() - 60 * 60_000).toISOString()
    );
    const result = await scanMainCi(
      { [repository]: ["pr"] },
      ciFailureReader(repository, shaA, status),
      async () => {
        dispatches += 1;
      },
      controlRepository
    );
    if (attempts < maxCiFailureAttempts) {
      assert.equal(dispatches, 1, `expected retry after ${attempts} verified failures`);
      assert.equal(result.dispatched, 1);
    } else {
      assert.equal(dispatches, 0, "the same fingerprint must open the circuit at the limit");
      assert.equal(result.already_processed, 1);
    }
  }
});

test("central CI waits for server Retry-After before retrying the same fingerprint", async () => {
  const repository = "fongap-labs/example";
  const createdAt = new Date(Date.now() - 60_000).toISOString();
  const status = signedFailures(repository, shaA, [801], createdAt, 900);
  let dispatches = 0;
  const result = await scanMainCi(
    { [repository]: ["pr"] },
    ciFailureReader(repository, shaA, status),
    async () => {
      dispatches += 1;
    },
    controlRepository
  );
  assert.equal(dispatches, 0);
  assert.equal(result.in_flight, 1);
});

test("permanent failures stop, while a new source SHA gets a fresh evaluation", async () => {
  const repository = "fongap-labs/example";
  const permanent = attestFixtureResponseForPath(`repos/${repository}/commits/${shaA}/status`, {
    statuses: [
      {
        context: "CI Evidence",
        state: "failure",
        description: `N:${failureFingerprint}`,
        target_url: `https://github.com/${controlRepository}/actions/runs/901`,
        created_at: new Date().toISOString(),
      },
    ],
  });
  let permanentDispatches = 0;
  const stopped = await scanMainCi(
    { [repository]: ["pr"] },
    ciFailureReader(repository, shaA, permanent),
    async () => {
      permanentDispatches += 1;
    },
    controlRepository
  );
  assert.equal(permanentDispatches, 0);
  assert.equal(stopped.already_processed, 1);

  let newShaDispatches = 0;
  const fresh = await scanMainCi(
    { [repository]: ["pr"] },
    ciFailureReader(repository, shaB, { statuses: [] }),
    async (target, sha) => {
      assert.equal(target, repository);
      assert.equal(sha, shaB);
      newShaDispatches += 1;
    },
    controlRepository
  );
  assert.equal(newShaDispatches, 1);
  assert.equal(fresh.dispatched, 1);
});

test("intake reservation prevents a second same-SHA dispatch while the first run starts", async () => {
  const repository = "fongap-labs/example";
  let reserved = false;
  let dispatches = 0;
  const reader = {
    async get(path: string): Promise<unknown> {
      if (path === `repos/${repository}/commits?per_page=1`) return [{ sha: shaC }];
      if (path === `repos/${repository}/commits/${shaC}/status`) {
        const value = reserved
          ? {
              statuses: [
                {
                  context: "CI Evidence",
                  state: "pending",
                  description: "Central CI queued",
                  target_url: `https://github.com/${controlRepository}/actions/runs/902`,
                  created_at: new Date().toISOString(),
                  updated_at: new Date().toISOString(),
                },
              ],
            }
          : { statuses: [] };
        return attestFixtureResponseForPath(path, value);
      }
      if (path === `repos/${controlRepository}/actions/runs/902`) {
        return { status: "completed", conclusion: "failure" };
      }
      throw new Error(`unexpected API path: ${path}`);
    },
  };
  const policy = { [repository]: ["pr"] };
  const first = await scanMainCi(
    policy,
    reader,
    async () => {
      dispatches += 1;
    },
    controlRepository,
    async () => {
      reserved = true;
    }
  );
  const concurrent = await scanMainCi(
    policy,
    reader,
    async () => {
      dispatches += 1;
    },
    controlRepository
  );
  assert.equal(first.dispatched, 1);
  assert.equal(concurrent.in_flight, 1);
  assert.equal(dispatches, 1);
});
