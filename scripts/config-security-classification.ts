import { CliError } from "./runtime-command.ts";

// This classifier is a conservative, non-authoritative safety floor. Existing
// AW_REPOSITORY_POLICY, task/deploy Secret policies, and environment mapping
// remain the only authorization authorities. An inventory must never grant access.
export type ConfigSensitivity = "secret" | "variable";
export type ConfigSecurityImpact =
  | "ordinary-business"
  | "security-sensitive"
  | "authorization-policy"
  | "root-trust";

export type ConfigIdentity = {
  logical_name: string;
  business_owner: string;
  product: string;
  execution_repository: string;
  storage_platform: "github";
  storage_repository: string;
  storage_scope: "repository" | "environment" | "organization";
  environment: string | null;
  stored_name: string;
  consumer_platform: string;
  consumer_name: string;
  credential_type: string;
  source: "existing" | "generated" | "imported" | "consumer-declaration";
  sensitivity: ConfigSensitivity;
  security_impact: ConfigSecurityImpact;
  generation_policy: "never" | "first-initialization-only";
  verification: string;
  rotation_policy: "manual" | "approved-plan";
};

const identifier = /^[A-Z][A-Z0-9_]*$/;
const repository = /^fongap-labs\/[A-Za-z0-9_.-]+$/;
const impactRank: Record<ConfigSecurityImpact, number> = {
  "ordinary-business": 0,
  "security-sensitive": 1,
  "authorization-policy": 2,
  "root-trust": 3,
};

// Values and contents are never inspected. These rules only flag sensitive
// names. A conservative match may require review, but must never authorize a
// write or override an explicitly higher classification.
const rootTrustNames = new Set([
  "AW_ARTIFACT_KEY",
  "AW_APP_PRIVATE_KEY",
  "AW_PUBLICATION_PRIVATE_KEY",
  "AW_PUBLICATION_PUBLIC_KEY",
  "AW_STATUS_KEYRING",
  "AW_MAIN_WRITE_GUARD_PUBLIC_KEY",
  "AW_CI_EVIDENCE_PUBLIC_KEY",
  "AW_SIGNING_PRIVATE_KEY",
  "AW_SIGNING_PUBLIC_KEY",
]);

const authorizationNames = new Set([
  "AW_REPOSITORY_POLICY",
  "AW_TASK_SECRET_POLICY_MODE",
  "AW_DEPLOY_SECRET_POLICY",
  "AW_MAIN_WRITE_GUARD_POLICY",
  "AW_CI_EVIDENCE_POLICY",
  "AW_PUBLICATION_TARGETS",
  "AW_PUBLICATION_TARGET_POLICY",
  "AW_TASK_ISOLATION_PILOT_ENABLED",
  "AW_TASK_ISOLATION_PILOT_GROUP",
]);

export function minimumConfigImpact(name: string): ConfigSecurityImpact {
  if (!identifier.test(name)) {
    throw new CliError("Configuration identity has an invalid name.", 65);
  }
  if (
    rootTrustNames.has(name) ||
    /(?:^|_)(?:ROOT_PRIVATE_KEY|PRIVATE_SIGNING_KEY|SIGNING_PRIVATE_KEY|SIGNING_PUBLIC_KEY|PUBLICATION_PUBLIC_KEY|CI_EVIDENCE_PUBLIC_KEY|TRUST_PUBLIC_KEY|TRUSTED_PUBLIC_KEY|ARTIFACT_KEY|STATUS_KEYRING)$/.test(
      name
    )
  ) {
    return "root-trust";
  }
  if (
    authorizationNames.has(name) ||
    /(?:^|_)(?:REPOSITORY_POLICY|AUTHORIZATION_POLICY|AUTHZ_POLICY|SECRET_POLICY|DEPLOY_POLICY|ENVIRONMENT_POLICY|PERMISSION_POLICY|MAIN_WRITE_GUARD|CI_EVIDENCE|SECRET_ALIAS|KEY_ALIAS|TRUSTED_WORKFLOW|TRUSTED_SOURCE|PUBLICATION_TARGET|PUBLISH_TARGET|APPROVED_TARGET)(?:_|$)/.test(
      name
    ) ||
    /(?:^|_)(?:SECURITY|AUTHORIZATION|AUTHZ|GUARD|SIGNING|POLICY)_(?:ENABLED|MODE|ALLOWLIST|MAPPING|RULES)$/.test(
      name
    )
  ) {
    return "authorization-policy";
  }
  if (
    /(?:^|_)(?:TOKEN|SECRET|PASSWORD|PASSPHRASE|PRIVATE_KEY|ACCESS_KEY|CREDENTIAL|API_KEY)(?:_|$)/.test(
      name
    ) ||
    /(?:^|_)(?:SECURITY|AUTH|AUTHN|AUTHZ|ALLOW|DENY|CI_EVIDENCE|MAIN_WRITE|ISOLATION|TRUST|PERMISSION|PUBLISH|PUBLICATION|SIGNATURE|SIGNING)(?:_|$)/.test(
      name
    )
  ) {
    return "security-sensitive";
  }
  return "ordinary-business";
}

export function classifyConfig(
  name: string,
  sensitivity: ConfigSensitivity
): { sensitivity: ConfigSensitivity; security_impact: ConfigSecurityImpact } {
  if (sensitivity !== "secret" && sensitivity !== "variable") {
    throw new CliError("Configuration sensitivity is invalid.", 65);
  }
  const minimum = minimumConfigImpact(name);
  return {
    sensitivity,
    security_impact:
      sensitivity === "secret" && minimum === "ordinary-business" ? "security-sensitive" : minimum,
  };
}

function validNonempty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

export function validateConfigIdentity(value: ConfigIdentity): void {
  const name = value.logical_name;
  const stored = value.stored_name;
  if (
    !identifier.test(name) ||
    !identifier.test(stored) ||
    !identifier.test(value.consumer_name) ||
    !repository.test(value.business_owner) ||
    value.execution_repository !== "fongap-labs/action-worker" ||
    !repository.test(value.storage_repository) ||
    value.storage_platform !== "github" ||
    !["repository", "environment", "organization"].includes(value.storage_scope) ||
    (value.storage_scope === "environment"
      ? !validNonempty(value.environment)
      : value.environment !== null) ||
    !validNonempty(value.product) ||
    !validNonempty(value.consumer_platform) ||
    !validNonempty(value.credential_type) ||
    !validNonempty(value.verification) ||
    !["existing", "generated", "imported", "consumer-declaration"].includes(value.source) ||
    !["never", "first-initialization-only"].includes(value.generation_policy) ||
    !["manual", "approved-plan"].includes(value.rotation_policy)
  ) {
    throw new CliError("Configuration identity is incomplete or inconsistent.", 65);
  }
  const inferred = classifyConfig(name, value.sensitivity);
  const storedMinimum = classifyConfig(stored, value.sensitivity);
  const impact = impactRank[value.security_impact];
  if (
    impact === undefined ||
    impact < impactRank[inferred.security_impact] ||
    impact < impactRank[storedMinimum.security_impact]
  ) {
    throw new CliError("Configuration security impact cannot be downgraded by metadata.", 77);
  }
  // Logical and stored names with differing meanings require a separately
  // verified alias; this record cannot itself become alias authority.
  if (stored !== name && value.source === "generated") {
    throw new CliError("Generated configuration cannot invent an alias mapping.", 77);
  }
}

// This is a *safety precondition*, not a write grant. A future writer must
// separately verify a fresh approved plan, central authority and single-writer
// lease before calling any API. Security-sensitive Variables are never eligible
// for ordinary drift reconciliation.
export function assertOrdinaryVariableReconcileCandidate(identity: ConfigIdentity): void {
  validateConfigIdentity(identity);
  if (
    identity.sensitivity !== "variable" ||
    identity.security_impact !== "ordinary-business" ||
    identity.generation_policy !== "never" ||
    identity.stored_name !== identity.logical_name ||
    identity.source !== "consumer-declaration"
  ) {
    throw new CliError("Configuration requires a protected change plan.", 77);
  }
}
