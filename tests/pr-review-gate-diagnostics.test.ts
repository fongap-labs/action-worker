import assert from "node:assert/strict";
import { test } from "node:test";
import { blockedGateDiagnostics, buildReview } from "../scripts/publish-pr-review.ts";

const head = "a".repeat(40);
const control = "fongap-labs/action-worker";

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
