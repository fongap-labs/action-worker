import assert from "node:assert/strict";
import { test } from "node:test";
import { waitForSuccessfulArtifactRun } from "../scripts/resolve-release-target.ts";

const repository = "fongap-labs/action-worker";

function workflowRun(status: string, conclusion: string | null = null, source = repository) {
  return { status, conclusion, repository: { full_name: source } };
}

test("release target waits for the artifact producer to complete successfully", async () => {
  const responses = [
    workflowRun("in_progress"),
    workflowRun("in_progress"),
    workflowRun("completed", "success"),
  ];
  let readCount = 0;
  let pauses = 0;
  await waitForSuccessfulArtifactRun(
    async () => responses[readCount++]!,
    repository,
    4,
    async (ms) => {
      assert.equal(ms, 5_000);
      pauses += 1;
    }
  );
  assert.equal(readCount, 3);
  assert.equal(pauses, 2);
});

test("release target rejects completed producer failure without retry", async () => {
  let reads = 0;
  let pauses = 0;
  await assert.rejects(
    waitForSuccessfulArtifactRun(
      async () => {
        reads += 1;
        return workflowRun("completed", "failure");
      },
      repository,
      3,
      async () => {
        pauses += 1;
      }
    ),
    /producer run did not succeed/
  );
  assert.equal(reads, 1);
  assert.equal(pauses, 0);
});

test("release target never retries a producer with mismatched repository", async () => {
  let reads = 0;
  await assert.rejects(
    waitForSuccessfulArtifactRun(
      async () => {
        reads += 1;
        return workflowRun("in_progress", null, "fongap-labs/external-vault");
      },
      repository,
      3,
      async () => {
        assert.fail("foreign repository must fail immediately");
      }
    ),
    /repository does not match/
  );
  assert.equal(reads, 1);
});

test("release target rejects missing repository identity and unexpected status", async () => {
  await assert.rejects(
    waitForSuccessfulArtifactRun(async () => ({ status: "completed", conclusion: "success" }), repository, 1),
    /repository does not match/
  );
  await assert.rejects(
    waitForSuccessfulArtifactRun(async () => workflowRun("unknown"), repository, 1),
    /status is invalid/
  );
});

test("release target times out after its bounded polling budget", async () => {
  let reads = 0;
  let pauses = 0;
  await assert.rejects(
    waitForSuccessfulArtifactRun(
      async () => {
        reads += 1;
        return workflowRun("queued");
      },
      repository,
      3,
      async () => {
        pauses += 1;
      }
    ),
    /did not complete in time/
  );
  assert.equal(reads, 3);
  assert.equal(pauses, 2);
});
