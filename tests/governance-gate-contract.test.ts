import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  gateRoles,
  loadGateContract,
  parseGateContract,
  requiredGateContexts,
  workflowTrustRoles,
} from "../scripts/governance-gate-contract.ts";

function fixture(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(new URL("../policies/gate-contract.json", import.meta.url), "utf8")
  ) as Record<string, unknown>;
}

test("gate identities and trusted publishers are declared in one versioned policy", () => {
  const contract = loadGateContract();
  assert.equal(contract.schema_version, 1);
  assert.deepEqual(
    requiredGateContexts(contract),
    gateRoles.map((role) => contract.status_contexts[role])
  );
  assert.equal(new Set(requiredGateContexts(contract)).size, gateRoles.length);
  for (const role of workflowTrustRoles) {
    assert.ok(contract.trusted_workflows[role].length > 0);
    assert.ok(
      contract.trusted_workflows[role].every((path) => path.startsWith(".github/workflows/"))
    );
  }
});

test("gate policy fails closed on missing roles and duplicate contexts", () => {
  const absent = fixture();
  delete (absent.status_contexts as Record<string, unknown>).ci_evidence;
  assert.throws(() => parseGateContract(absent), /missing or unsupported keys/);

  const duplicate = fixture();
  const contexts = duplicate.status_contexts as Record<string, string>;
  contexts.merge_validation = contexts.pr_governance!;
  assert.throws(() => parseGateContract(duplicate), /must be unique/);

  const unknown = fixture();
  (unknown.status_contexts as Record<string, string>).unknown = "Unexpected";
  assert.throws(() => parseGateContract(unknown), /missing or unsupported keys/);
});

test("untrusted publisher paths and empty workflow trust sets are rejected", () => {
  const injected = fixture();
  (injected.trusted_workflows as Record<string, string[]>).ci_evidence = ["../attacker.yml"];
  assert.throws(() => parseGateContract(injected), /untrusted or duplicate/);

  const empty = fixture();
  (empty.trusted_workflows as Record<string, string[]>).pr_governance = [];
  assert.throws(() => parseGateContract(empty), /must be nonempty/);

  const duplicate = fixture();
  const paths = (duplicate.trusted_workflows as Record<string, string[]>).ci_evidence;
  assert.ok(paths);
  paths.push(paths[0]!);
  assert.throws(() => parseGateContract(duplicate), /untrusted or duplicate/);
});
