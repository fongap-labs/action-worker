import assert from "node:assert/strict";
import { test } from "node:test";
import {
  hasActiveCiEvidenceReservation,
  hasUnresolvedCiEvidenceFailure,
} from "../scripts/ci-failure-budget.ts";
import { attestFixtureResponseForPath } from "./attested-status-fixtures.ts";

const repository = "fongap-labs/example";
const controlRepository = "fongap-labs/action-worker";
const sha = "a".repeat(40);
const controlSha = "b".repeat(40);
const statusPath = `repos/${repository}/commits/${sha}/status`;

test("a signed active central run deduplicates another same-SHA dispatch", async () => {
  const response = attestFixtureResponseForPath(statusPath, {
    statuses: [
      {
        context: "CI Evidence",
        state: "pending",
        description: "Central CI running",
        target_url: `https://github.com/${controlRepository}/actions/runs/950`,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ],
  });
  const activeReader = {
    async get(path: string): Promise<unknown> {
      assert.equal(path, `repos/${controlRepository}/actions/runs/950`);
      return {
        repository: { full_name: controlRepository },
        path: ".github/workflows/central-ci-dispatch.yml",
        event: "repository_dispatch",
        head_branch: "main",
        status: "in_progress",
      };
    },
  };
  assert.equal(
    await hasActiveCiEvidenceReservation(
      response,
      activeReader,
      controlRepository,
      repository,
      sha
    ),
    true
  );
});

test("a completed old reservation expires and does not block a fresh dispatch", async () => {
  const old = new Date(Date.now() - 5 * 60_000).toISOString();
  const response = attestFixtureResponseForPath(statusPath, {
    statuses: [
      {
        context: "CI Evidence",
        state: "pending",
        description: "Central CI queued",
        target_url: `https://github.com/${controlRepository}/actions/runs/951`,
        created_at: old,
        updated_at: old,
      },
    ],
  });
  const reader = {
    async get(): Promise<unknown> {
      return {
        repository: { full_name: controlRepository },
        path: ".github/workflows/central-ci-dispatch.yml",
        head_branch: "main",
        status: "completed",
        conclusion: "cancelled",
      };
    },
  };
  assert.equal(
    await hasActiveCiEvidenceReservation(response, reader, controlRepository, repository, sha),
    false
  );
});

test("an unreported failure cannot loop on the same control revision", async () => {
  const response = attestFixtureResponseForPath(statusPath, {
    statuses: [
      {
        context: "CI Evidence",
        state: "pending",
        description: "Central CI running",
        target_url: `https://github.com/${controlRepository}/actions/runs/952`,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ],
  });
  const reader = {
    async get(path: string): Promise<unknown> {
      assert.equal(path, `repos/${controlRepository}/actions/runs/952`);
      return {
        repository: { full_name: controlRepository },
        path: ".github/workflows/central-ci-dispatch.yml",
        event: "repository_dispatch",
        head_branch: "main",
        head_sha: controlSha,
        status: "completed",
        conclusion: "failure",
      };
    },
  };
  assert.equal(
    await hasUnresolvedCiEvidenceFailure(
      response,
      reader,
      controlRepository,
      repository,
      sha,
      controlSha
    ),
    true
  );
  assert.equal(
    await hasUnresolvedCiEvidenceFailure(
      response,
      reader,
      controlRepository,
      repository,
      sha,
      "c".repeat(40)
    ),
    false
  );
});

test("an intake failure blocks retry only when its Main CI job failed", async () => {
  const response = attestFixtureResponseForPath(statusPath, {
    statuses: [
      {
        context: "CI Evidence",
        state: "pending",
        description: "Central CI queued by central intake",
        target_url: `https://github.com/${controlRepository}/actions/runs/953`,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ],
  });
  const reader = (conclusion: string) => ({
    async get(path: string): Promise<unknown> {
      if (path === `repos/${controlRepository}/actions/runs/953`) {
        return {
          repository: { full_name: controlRepository },
          path: ".github/workflows/intake.yml",
          head_branch: "main",
          head_sha: controlSha,
          status: "completed",
          conclusion: "failure",
        };
      }
      if (path === `repos/${controlRepository}/actions/runs/953/jobs?per_page=100`) {
        return { jobs: [{ name: "Main CI", conclusion }] };
      }
      throw new Error(`unexpected API path: ${path}`);
    },
  });
  assert.equal(
    await hasUnresolvedCiEvidenceFailure(
      response,
      reader("failure"),
      controlRepository,
      repository,
      sha,
      controlSha
    ),
    true
  );
  assert.equal(
    await hasUnresolvedCiEvidenceFailure(
      response,
      reader("success"),
      controlRepository,
      repository,
      sha,
      controlSha
    ),
    false
  );
});
