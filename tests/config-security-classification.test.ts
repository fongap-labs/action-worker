import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertOrdinaryVariableReconcileCandidate,
  type ConfigIdentity,
  classifyConfig,
  minimumConfigImpact,
  validateConfigIdentity,
} from "../scripts/config-security-classification.ts";

const base: ConfigIdentity = {
  logical_name: "EXAMPLE_DISPLAY_NAME",
  business_owner: "fongap-labs/example",
  product: "example",
  execution_repository: "fongap-labs/action-worker",
  storage_platform: "github",
  storage_repository: "fongap-labs/action-worker",
  storage_scope: "repository",
  environment: null,
  stored_name: "EXAMPLE_DISPLAY_NAME",
  consumer_platform: "example-runtime",
  consumer_name: "EXAMPLE_DISPLAY_NAME",
  credential_type: "plain-text",
  source: "consumer-declaration",
  sensitivity: "variable",
  security_impact: "ordinary-business",
  generation_policy: "never",
  verification: "consumer-specific",
  rotation_policy: "manual",
};

test("configuration data sensitivity and security impact are independent dimensions", () => {
  assert.deepEqual(classifyConfig("EXAMPLE_DISPLAY_NAME", "variable"), {
    sensitivity: "variable",
    security_impact: "ordinary-business",
  });
  assert.deepEqual(classifyConfig("EXAMPLE_DISPLAY_NAME", "secret"), {
    sensitivity: "secret",
    security_impact: "security-sensitive",
  });
  assert.equal(minimumConfigImpact("AW_REPOSITORY_POLICY"), "authorization-policy");
  assert.equal(minimumConfigImpact("AW_TASK_ISOLATION_PILOT_ENABLED"), "authorization-policy");
  assert.equal(minimumConfigImpact("AW_MAIN_WRITE_GUARD_POLICY"), "authorization-policy");
  assert.equal(minimumConfigImpact("AW_CI_EVIDENCE_PUBLIC_KEY"), "root-trust");
  assert.equal(minimumConfigImpact("AW_PUBLICATION_PUBLIC_KEY"), "root-trust");
  assert.equal(minimumConfigImpact("AW_ARTIFACT_KEY"), "root-trust");
  assert.equal(minimumConfigImpact("SERVICE_API_TOKEN"), "security-sensitive");
  assert.throws(() => minimumConfigImpact("unsafe/name"), /invalid name/);
});

test("config identity cannot downgrade security classifications or invent aliases", () => {
  validateConfigIdentity(base);
  assertOrdinaryVariableReconcileCandidate(base);
  assert.throws(
    () =>
      validateConfigIdentity({
        ...base,
        logical_name: "AW_REPOSITORY_POLICY",
        stored_name: "AW_REPOSITORY_POLICY",
        consumer_name: "AW_REPOSITORY_POLICY",
      }),
    /cannot be downgraded/
  );
  assert.throws(
    () =>
      validateConfigIdentity({
        ...base,
        logical_name: "AW_PUBLICATION_PUBLIC_KEY",
        stored_name: "AW_PUBLICATION_PUBLIC_KEY",
        consumer_name: "AW_PUBLICATION_PUBLIC_KEY",
        security_impact: "authorization-policy",
      }),
    /cannot be downgraded/
  );
  assert.throws(
    () =>
      validateConfigIdentity({
        ...base,
        source: "generated",
        stored_name: "EXAMPLE_DIFFERENT_NAME",
      }),
    /cannot invent an alias/
  );
});

test("ordinary reconciliation gate requires consumer declaration and never generates Secrets", () => {
  for (const altered of [
    { sensitivity: "secret" as const, security_impact: "security-sensitive" as const },
    { source: "imported" as const },
    { generation_policy: "first-initialization-only" as const },
    { security_impact: "authorization-policy" as const },
    { stored_name: "EXAMPLE_ALIAS" },
  ]) {
    assert.throws(
      () => assertOrdinaryVariableReconcileCandidate({ ...base, ...altered }),
      /protected change plan/
    );
  }
  assert.throws(
    () =>
      validateConfigIdentity({
        ...base,
        storage_scope: "environment",
        environment: null,
      }),
    /incomplete or inconsistent/
  );
});
