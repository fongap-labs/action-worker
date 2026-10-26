import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isUnfinished,
  latestGovernanceStatus,
  targetRunId,
} from "../scripts/resolve-unfinished-governance.ts";

const control = "fongap-labs/action-worker";
const ownRun = "https://github.com/fongap-labs/action-worker/actions/runs/40331028617";

test("the newest PR Governance status decides, and other contexts are ignored", () => {
  const combined = {
    statuses: [
      {
        context: "CI Evidence",
        state: "success",
        created_at: "2026-10-26T13:40:00Z",
        target_url: "x",
      },
      {
        context: "PR Governance",
        state: "success",
        created_at: "2026-10-26T13:10:00Z",
        target_url: "a",
      },
      {
        context: "PR Governance",
        state: "pending",
        created_at: "2026-10-26T13:29:28Z",
        target_url: "b",
      },
    ],
  };
  assert.deepEqual(latestGovernanceStatus(combined), { state: "pending", target: "b" });
  assert.equal(latestGovernanceStatus({ statuses: [] }), null);
});

test("a status points at a run only when that run is in the control repository", () => {
  assert.equal(
    targetRunId(`https://github.com/${control}/actions/runs/40330992012`, control),
    40330992012
  );
  assert.equal(
    targetRunId("https://github.com/fongap-labs/delta-suite/actions/runs/1", control),
    null
  );
  assert.equal(targetRunId("https://example.test/runs/1", control), null);
});

test("a pending status is unfinished when its own run ended or its named run completed", () => {
  const pending = (target: string) => ({ state: "pending", target });
  // The run that failed before marking its head.
  assert.equal(isUnfinished(pending(ownRun), ownRun, false), true);
  // The intake that queued it has completed, so no run will update it.
  assert.equal(isUnfinished(pending("intake"), ownRun, true), true);
  // Another run is still working on it: leave it alone.
  assert.equal(isUnfinished(pending("intake"), ownRun, false), false);
  // A finished status is never rewritten.
  assert.equal(isUnfinished({ state: "success", target: ownRun }, ownRun, true), false);
  assert.equal(isUnfinished(null, ownRun, true), false);
});
