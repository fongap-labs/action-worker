import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { loadGateContract, requiredGateContexts } from "../scripts/governance-gate-contract.ts";

test("PR gate consumers read display names from the declared contract", () => {
  const contexts = requiredGateContexts(loadGateContract());
  for (const file of [
    "scripts/set-pr-status.ts",
    "scripts/auto-merge-pr.ts",
    "scripts/publish-pr-review.ts",
  ]) {
    const source = readFileSync(file, "utf8");
    for (const context of contexts) {
      assert.equal(
        source.includes(`"${context}"`),
        false,
        `${file} embeds a configured status context`
      );
    }
  }
});
