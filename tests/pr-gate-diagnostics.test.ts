import assert from "node:assert/strict";
import { test } from "node:test";
import {
  blockedGateDiagnostics,
  buildReview,
  evaluateMergeDisplayGate,
} from "../scripts/publish-pr-review.ts";
import { attestFixtureStatuses } from "./attested-status-fixtures.ts";

const head = "a".repeat(40);
const control = "fongap-labs/action-worker";
const target = "fongap-labs/dsh-plugin";

test("PR gate display accepts a signed no-CI verdict as policy success", () => {
  const statuses = attestFixtureStatuses(
    {
      statuses: [
        ...["PR Governance", "CI Evidence", "validate-merge"].map((context) => ({
          context,
          state: "success",
          description:
            context === "CI Evidence"
              ? "CI not run: the governance plan does not require CI"
              : "gate passed",
          target_url: "https://github.com/fongap-labs/action-worker/actions/runs/321",
          created_at: "2026-11-19T00:00:00Z",
        })),
      ],
    },
    target,
    head
  );
  assert.deepEqual(
    evaluateMergeDisplayGate({ head: { sha: head } }, statuses, head, control, target),
    { current: true, status: "success" }
  );
});

test("blocked PR comment reports only trusted control run links", () => {
  const diagnostics = blockedGateDiagnostics(
    {
      statuses: [
        {
          context: "CI Evidence",
          state: "failure",
          target_url: "https://github.com/fongap-labs/action-worker/actions/runs/321",
          created_at: "2026-11-07T00:00:00Z",
        },
        {
          context: "PR Governance",
          state: "failure",
          target_url: "https://evil.example/runs/42",
          created_at: "2026-11-07T00:00:00Z",
        },
      ],
    },
    control,
    "fongap-labs/dsh-plugin",
    head
  );
  const body = buildReview(
    "failure",
    "https://github.com/fongap-labs/action-worker/actions/runs/999",
    {},
    undefined,
    false,
    "",
    false,
    diagnostics
  );
  assert.match(body, /Deterministic gate diagnostics/);
  assert.match(body, /github\.com\/fongap-labs\/action-worker\/actions\/runs\/321/);
  assert.doesNotMatch(body, /evil\.example/);
  assert.match(body, /AI Review cannot override the gate/);
});
