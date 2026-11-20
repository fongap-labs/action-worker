import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  ciEvidenceWorkflowPaths,
  ciFailureWorkflowPaths,
  mainWriteGuardWorkflowPaths,
  prGateWorkflowPaths,
} from "../scripts/ci-evidence.ts";
import { loadGateContract, parseGateContract } from "../scripts/governance-gate-contract.ts";

test("CI provenance uses trusted policy without expanding failure authority", () => {
  const contract = loadGateContract();
  assert.deepEqual(ciEvidenceWorkflowPaths, contract.trusted_workflows.ci_evidence);
  assert.deepEqual(ciFailureWorkflowPaths, contract.trusted_workflows.ci_failure);
  assert.deepEqual(prGateWorkflowPaths, contract.trusted_workflows.pr_governance);
  assert.deepEqual(mainWriteGuardWorkflowPaths, contract.trusted_workflows.main_write_guard);
  for (const path of ciFailureWorkflowPaths) {
    assert.ok(ciEvidenceWorkflowPaths.includes(path));
  }
});

test("CI evidence implementation does not embed gate names or workflow filenames", () => {
  const source = readFileSync("scripts/ci-evidence.ts", "utf8");
  const contract = loadGateContract();
  for (const context of Object.values(contract.status_contexts)) {
    assert.equal(source.includes(`"${context}"`), false);
  }
  for (const paths of Object.values(contract.trusted_workflows)) {
    for (const path of paths) {
      assert.equal(source.includes(`"${path}"`), false);
    }
  }
});

test("missing CI failure publisher authority fails closed", () => {
  const policy = structuredClone(loadGateContract()) as unknown as Record<string, unknown>;
  const publishers = policy.trusted_workflows as Record<string, unknown>;
  delete publishers.ci_failure;
  assert.throws(() => parseGateContract(policy), /missing or unsupported keys/);
});
