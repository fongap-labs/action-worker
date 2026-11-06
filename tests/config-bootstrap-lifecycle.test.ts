import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assessConfigLifecycle,
  type ConfigLifecycleEvidence,
} from "../scripts/config-bootstrap-lifecycle.ts";

const fresh: ConfigLifecycleEvidence = {
  planApproved: true,
  planFresh: true,
  sourcePolicyUnchanged: true,
  storageLocationVerified: true,
  environmentProtectionVerified: true,
  exclusiveWriterVerified: true,
  generationPermitted: true,
  consumerConfirmedUnused: true,
  historicalEncryptedDataAbsent: true,
  priorOperation: "none",
  metadata: "absent",
  consumerVerification: "not-run",
  historicalDependency: false,
  recoverableBackup: false,
};

test("first initialization requires every independent proof and never directly authorizes a write", () => {
  const result = assessConfigLifecycle(fresh);
  assert.equal(result.state, "first-initialization");
  assert.equal(result.mayRequestProtectedInitialization, true);
  assert.equal(result.automaticWritesAllowed, false);
  for (const key of [
    "planApproved",
    "planFresh",
    "sourcePolicyUnchanged",
    "storageLocationVerified",
    "environmentProtectionVerified",
    "exclusiveWriterVerified",
    "generationPermitted",
    "consumerConfirmedUnused",
    "historicalEncryptedDataAbsent",
  ] as const) {
    const denied = assessConfigLifecycle({ ...fresh, [key]: false });
    assert.equal(denied.mayRequestProtectedInitialization, false, key);
    assert.equal(denied.automaticWritesAllowed, false);
  }
});

test("known existing, inaccessible, partial and unknown outcomes are never reinitialized", () => {
  const variants: Array<[Partial<ConfigLifecycleEvidence>, string]> = [
    [{ metadata: "present" }, "existing-pending-verification"],
    [{ metadata: "present", consumerVerification: "valid" }, "verified"],
    [{ metadata: "present", consumerVerification: "invalid" }, "manual-recovery"],
    [{ metadata: "inaccessible" }, "access-restricted"],
    [{ consumerVerification: "inaccessible" }, "access-restricted"],
    [{ metadata: "unknown" }, "result-unknown"],
    [{ priorOperation: "unknown" }, "result-unknown"],
    [{ priorOperation: "in-progress" }, "partially-completed"],
    [{ priorOperation: "completed" }, "result-unknown"],
  ];
  for (const [changes, state] of variants) {
    const actual = assessConfigLifecycle({ ...fresh, ...changes });
    assert.equal(actual.state, state);
    assert.equal(actual.mayRequestProtectedInitialization, false);
    assert.equal(actual.automaticWritesAllowed, false);
  }
});

test("a missing key required for historical data must enter recovery, never key generation", () => {
  for (const recoverableBackup of [false, true]) {
    const result = assessConfigLifecycle({
      ...fresh,
      historicalDependency: true,
      historicalEncryptedDataAbsent: false,
      recoverableBackup,
    });
    assert.equal(result.state, recoverableBackup ? "manual-recovery" : "historical-key-missing");
    assert.equal(result.mayRequestProtectedInitialization, false);
    assert.equal(result.automaticWritesAllowed, false);
  }
});

test("unknown or malformed evidence refuses all lifecycle decisions", () => {
  assert.throws(() => assessConfigLifecycle({ ...fresh, planApproved: "yes" } as never), /invalid/);
  assert.throws(
    () => assessConfigLifecycle({ ...fresh, additional: "false" } as never),
    /incomplete/
  );
  assert.throws(
    () => assessConfigLifecycle({ ...fresh, metadata: "missing" } as never),
    /incomplete/
  );
  assert.throws(() => assessConfigLifecycle(null as never), /incomplete/);
});
