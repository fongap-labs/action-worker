import { readFileSync } from "node:fs";
import { CliError } from "./runtime-command.ts";

// These keys describe proof roles, not human-readable GitHub status names.
export const gateRoles = ["pr_governance", "ci_evidence", "merge_validation"] as const;
export type GateRole = (typeof gateRoles)[number];
export const workflowTrustRoles = [
  "ci_evidence",
  "ci_failure",
  "pr_governance",
  "main_write_guard",
] as const;
export type WorkflowTrustRole = (typeof workflowTrustRoles)[number];

export type GateContract = {
  schema_version: 1;
  status_contexts: Record<GateRole, string>;
  dev_status_contexts: Record<GateRole, string>;
  trusted_workflows: Record<WorkflowTrustRole, readonly string[]>;
  advisory: { merge_blocked_label: string };
};

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CliError(`Invalid gate contract: ${field} must be an object.`, 65);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], field: string): void {
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    throw new CliError(`Invalid gate contract: ${field} has missing or unsupported keys.`, 65);
  }
}

function hasControlCharacters(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

function nonemptyString(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    value.length === 0 ||
    value.length > 100 ||
    hasControlCharacters(value)
  ) {
    throw new CliError(`Invalid gate contract: ${field} must be a nonempty safe string.`, 65);
  }
  return value;
}

export function parseGateContract(raw: unknown): GateContract {
  const root = object(raw, "root");
  exactKeys(
    root,
    ["schema_version", "status_contexts", "dev_status_contexts", "trusted_workflows", "advisory"],
    "root"
  );
  if (root.schema_version !== 1) {
    throw new CliError("Invalid gate contract schema version.", 65);
  }

  const declaredContexts = object(root.status_contexts, "status_contexts");
  exactKeys(declaredContexts, gateRoles, "status_contexts");
  const contexts = {} as Record<GateRole, string>;
  for (const role of gateRoles) {
    contexts[role] = nonemptyString(declaredContexts[role], `status_contexts.${role}`);
  }
  const declaredDevContexts = object(root.dev_status_contexts, "dev_status_contexts");
  exactKeys(declaredDevContexts, gateRoles, "dev_status_contexts");
  const devContexts = {} as Record<GateRole, string>;
  for (const role of gateRoles) {
    devContexts[role] = nonemptyString(declaredDevContexts[role], `dev_status_contexts.${role}`);
  }
  const allContexts = [...Object.values(contexts), ...Object.values(devContexts)];
  if (new Set(allContexts.map((context) => context.toLowerCase())).size !== allContexts.length) {
    throw new CliError("Invalid gate contract: status contexts must be unique.", 65);
  }

  const declaredWorkflows = object(root.trusted_workflows, "trusted_workflows");
  exactKeys(declaredWorkflows, workflowTrustRoles, "trusted_workflows");
  const workflows = {} as Record<WorkflowTrustRole, readonly string[]>;
  for (const role of workflowTrustRoles) {
    const candidate = declaredWorkflows[role];
    if (!Array.isArray(candidate) || candidate.length === 0) {
      throw new CliError(`Invalid gate contract: trusted_workflows.${role} must be nonempty.`, 65);
    }
    const paths = candidate.map((value: unknown) =>
      nonemptyString(value, `trusted_workflows.${role}`)
    );
    if (
      paths.some((path: string) => !/^\.github\/workflows\/[a-zA-Z0-9_.-]+\.ya?ml$/.test(path)) ||
      new Set(paths).size !== paths.length
    ) {
      throw new CliError(
        `Invalid gate contract: untrusted or duplicate workflow path for ${role}.`,
        65
      );
    }
    workflows[role] = paths;
  }

  const declaredAdvisory = object(root.advisory, "advisory");
  exactKeys(declaredAdvisory, ["merge_blocked_label"], "advisory");
  const mergeBlockedLabel = nonemptyString(
    declaredAdvisory.merge_blocked_label,
    "advisory.merge_blocked_label"
  );
  if (!/^[a-z0-9][a-z0-9-]*$/.test(mergeBlockedLabel)) {
    throw new CliError("Invalid gate contract: merge-blocked label is malformed.", 65);
  }
  return {
    schema_version: 1,
    status_contexts: contexts,
    dev_status_contexts: devContexts,
    trusted_workflows: workflows,
    advisory: { merge_blocked_label: mergeBlockedLabel },
  };
}

// The caller must use its trusted checkout of the control repository.
// Never fetch a policy from a target PR branch or discover trusted publishers from a PR payload.
export function loadGateContract(): GateContract {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      readFileSync(new URL("../policies/gate-contract.json", import.meta.url), "utf8")
    );
  } catch {
    throw new CliError("Gate contract is unavailable or malformed.", 65);
  }
  return parseGateContract(parsed);
}

export function gateContextsForBranch(
  contract: GateContract,
  branch: string
): Record<GateRole, string> {
  if (branch === "main") return contract.status_contexts;
  if (branch === "dev") return contract.dev_status_contexts;
  throw new CliError("Invalid gate target branch.", 65);
}

export function requiredGateContexts(contract: GateContract, branch = "main"): readonly string[] {
  const contexts = gateContextsForBranch(contract, branch);
  return gateRoles.map((role) => contexts[role]);
}
