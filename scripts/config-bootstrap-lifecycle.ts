import { CliError } from "./runtime-command.ts";

// Pure, read-only decision logic. This module never creates a key, issues a
// GitHub write request, or treats metadata visibility as a verified Secret.
export type ConfigLifecycleState =
  | "first-initialization"
  | "existing-pending-verification"
  | "access-restricted"
  | "historical-key-missing"
  | "partially-completed"
  | "verified"
  | "result-unknown"
  | "manual-recovery";

export type ConfigLifecycleEvidence = {
  planApproved: boolean;
  planFresh: boolean;
  sourcePolicyUnchanged: boolean;
  storageLocationVerified: boolean;
  environmentProtectionVerified: boolean;
  exclusiveWriterVerified: boolean;
  generationPermitted: boolean;
  consumerConfirmedUnused: boolean;
  historicalEncryptedDataAbsent: boolean;
  priorOperation: "none" | "in-progress" | "completed" | "unknown";
  metadata: "absent" | "present" | "inaccessible" | "unknown";
  consumerVerification: "not-run" | "valid" | "invalid" | "inaccessible";
  historicalDependency: boolean;
  recoverableBackup: boolean;
};

export type LifecycleDecision = {
  state: ConfigLifecycleState;
  mayRequestProtectedInitialization: boolean;
  requiresHumanReview: boolean;
  automaticWritesAllowed: false;
};

function decision(
  state: ConfigLifecycleState,
  canRequestProtectedInitialization = false
): LifecycleDecision {
  return {
    state,
    mayRequestProtectedInitialization: canRequestProtectedInitialization,
    requiresHumanReview: state !== "verified",
    automaticWritesAllowed: false,
  };
}

export function assessConfigLifecycle(evidence: ConfigLifecycleEvidence): LifecycleDecision {
  if (
    !evidence ||
    typeof evidence !== "object" ||
    Object.values(evidence).some((value) => value === null || value === undefined) ||
    Object.keys(evidence).length !== 14 ||
    !["none", "in-progress", "completed", "unknown"].includes(evidence.priorOperation) ||
    !["absent", "present", "inaccessible", "unknown"].includes(evidence.metadata) ||
    !["not-run", "valid", "invalid", "inaccessible"].includes(evidence.consumerVerification)
  ) {
    throw new CliError("Configuration lifecycle evidence is incomplete.", 65);
  }
  const booleanFields: Array<keyof ConfigLifecycleEvidence> = [
    "planApproved",
    "planFresh",
    "sourcePolicyUnchanged",
    "storageLocationVerified",
    "environmentProtectionVerified",
    "exclusiveWriterVerified",
    "generationPermitted",
    "consumerConfirmedUnused",
    "historicalEncryptedDataAbsent",
    "historicalDependency",
    "recoverableBackup",
  ];
  if (booleanFields.some((field) => typeof evidence[field] !== "boolean")) {
    throw new CliError("Configuration lifecycle evidence has invalid fields.", 65);
  }

  if (evidence.priorOperation === "unknown" || evidence.metadata === "unknown") {
    return decision("result-unknown");
  }
  if (evidence.metadata === "inaccessible" || evidence.consumerVerification === "inaccessible") {
    return decision("access-restricted");
  }
  if (evidence.priorOperation === "in-progress") {
    return decision("partially-completed");
  }
  if (evidence.historicalDependency && evidence.metadata === "absent") {
    return decision(evidence.recoverableBackup ? "manual-recovery" : "historical-key-missing");
  }
  if (evidence.metadata === "present") {
    return decision(
      evidence.consumerVerification === "valid"
        ? "verified"
        : evidence.consumerVerification === "invalid"
          ? "manual-recovery"
          : "existing-pending-verification"
    );
  }
  if (evidence.priorOperation === "completed") {
    return decision("result-unknown");
  }
  if (
    !evidence.planApproved ||
    !evidence.planFresh ||
    !evidence.sourcePolicyUnchanged ||
    !evidence.storageLocationVerified ||
    !evidence.environmentProtectionVerified ||
    !evidence.exclusiveWriterVerified ||
    !evidence.generationPermitted ||
    !evidence.consumerConfirmedUnused ||
    !evidence.historicalEncryptedDataAbsent ||
    evidence.historicalDependency ||
    evidence.consumerVerification !== "not-run"
  ) {
    return decision("manual-recovery");
  }
  // Eligibility never means authorization to write. A future protected
  // single-writer runner must recheck all conditions under its lock.
  return decision("first-initialization", true);
}
