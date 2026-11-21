import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { GithubHttpError } from "../scripts/github-api.ts";
import {
  cacheImmutablePrivateEvidence,
  waitForPrivateCiEvidence,
} from "../scripts/private-ci-wait.ts";
import { CliError } from "../scripts/runtime-command.ts";

test("one bounded process waits for all source-owned jobs without weakening verdict", async () => {
  let current = 1_000_000;
  let checks = 0;
  const pauses: number[] = [];
  const result = await waitForPrivateCiEvidence(
    async () => {
      checks += 1;
      if (checks < 4)
        throw new CliError("Private source CI evidence is absent, stale or incomplete.", 65);
      return { runId: 44, attempt: 1 };
    },
    {
      timeoutMs: 600_000,
      pollMs: 90_000,
      now: () => current,
      sleep: async (ms) => {
        pauses.push(ms);
        current += ms;
      },
    }
  );
  assert.deepEqual(result, { runId: 44, attempt: 1 });
  assert.equal(checks, 4);
  assert.deepEqual(pauses, [90_000, 90_000, 90_000]);
});

test("GitHub primary limit waits until actual reset rather than hammering", async () => {
  let current = 1_000_000;
  let tries = 0;
  const pauses: number[] = [];
  await waitForPrivateCiEvidence(
    async () => {
      tries += 1;
      if (tries === 1) {
        throw new GithubHttpError(403, undefined, {
          kind: "primary-rate-limit",
          resetAtMs: current + 330_000,
        });
      }
      return true;
    },
    {
      timeoutMs: 840_000,
      pollMs: 90_000,
      now: () => current,
      sleep: async (ms) => {
        pauses.push(ms);
        current += ms;
      },
    }
  );
  assert.deepEqual(pauses, [332_000]);
  assert.equal(tries, 2);
});

test("primary limit beyond budget and missing reset fail closed", async () => {
  let calls = 0;
  const options = {
    timeoutMs: 180_000,
    pollMs: 90_000,
    now: () => 1_000_000,
    sleep: async () => {
      throw new Error("Must never sleep when quota cannot recover inside budget.");
    },
  };
  await assert.rejects(
    waitForPrivateCiEvidence(async () => {
      calls++;
      throw new GithubHttpError(403, undefined, {
        kind: "primary-rate-limit",
        resetAtMs: 1_350_000,
      });
    }, options),
    /quota beyond the allowed window/
  );
  await assert.rejects(
    waitForPrivateCiEvidence(async () => {
      calls++;
      throw new GithubHttpError(403, undefined, { kind: "primary-rate-limit" });
    }, options),
    /quota reset unavailable/
  );
  assert.equal(calls, 2);
});

test("permission denial and malformed requests are never retried", async () => {
  let calls = 0;
  for (const error of [
    new GithubHttpError(403, undefined, { kind: "permission" }),
    new GithubHttpError(404),
    new CliError("Invalid verified identity", 64),
    new Error("Unexpected parser failure"),
  ]) {
    await assert.rejects(
      waitForPrivateCiEvidence(
        async () => {
          calls++;
          throw error;
        },
        {
          timeoutMs: 200_000,
          pollMs: 90_000,
          sleep: async () => {
            throw new Error("Unnecessary retry");
          },
        }
      ),
      (caught: unknown) => caught === error
    );
  }
  assert.equal(calls, 4);
});

test("incomplete source CI past deadline stays failing and validates wait budgets", async () => {
  let time = 0;
  let calls = 0;
  await assert.rejects(
    waitForPrivateCiEvidence(
      async () => {
        calls++;
        throw new CliError("Source run pending", 65);
      },
      {
        timeoutMs: 190_000,
        pollMs: 90_000,
        now: () => time,
        sleep: async (ms) => {
          time += ms;
        },
      }
    ),
    /bounded verification window/
  );
  assert.equal(calls, 3);
  await assert.rejects(
    waitForPrivateCiEvidence(async () => true, { timeoutMs: 1000, pollMs: 1000 }),
    /Invalid native private CI verification wait budget/
  );
});

test("commit-bound source objects are cached; live PR and CI evidence never is", async () => {
  const calls: string[] = [];
  const reader = cacheImmutablePrivateEvidence({
    get: async (path: string): Promise<unknown> => {
      calls.push(path);
      return { path, call: calls.length };
    },
  });
  const sha = "a".repeat(40);
  const paths = [
    `repos/fongap-labs/private-fixture/git/commits/${sha}`,
    `repos/fongap-labs/private-fixture/contents/.github/workflows/private-source-ci.yml?ref=${sha}`,
  ];
  for (const path of paths) {
    const first = await reader.get(path);
    const repeat = await reader.get(path);
    assert.deepEqual(first, repeat);
  }
  for (const path of [
    "repos/fongap-labs/private-fixture",
    "repos/fongap-labs/private-fixture/pulls/500",
    "repos/fongap-labs/private-fixture/actions/workflows/private-source-ci.yml/runs?per_page=100",
    "repos/fongap-labs/private-fixture/actions/runs/99/jobs?per_page=100",
  ]) {
    const first = await reader.get(path);
    const repeat = await reader.get(path);
    assert.notDeepEqual(first, repeat);
  }
  assert.equal(calls.length, 10);
});

test("CI dispatcher uses a single bounded verifier and retains private isolation", () => {
  const workflow = readFileSync(".github/workflows/central-ci-dispatch.yml", "utf8");
  const section = workflow
    .split("  native-private-pilot:\n")[1]
    ?.split("  native-private-ref:\n")[0];
  assert.ok(section);
  assert.match(section, /timeout-minutes: 50/);
  assert.match(section, /AW_NATIVE_PRIVATE_CI_WAIT_SECONDS: "2520"/);
  assert.match(section, /node scripts\/private-ci-gate\.ts/);
  assert.doesNotMatch(section, /for attempt in \{1\.\.16\}/);
  assert.match(section, /permission-actions: read/);
  assert.match(section, /permission-contents: read/);
  assert.doesNotMatch(section, /actions\/checkout[^\n]*private/);
});
