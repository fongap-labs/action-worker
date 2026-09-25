import { isJsonRecord } from "./github-api.ts";
import {
  executionOperations,
  type ExecutionJob,
  type ExecutionOperation,
} from "./execution-contract.ts";
import {
  runnerTrustDomains,
  type RunnerTrustDomain,
} from "./runner-policy.ts";
import { CliError } from "./runtime-command.ts";

type CapabilityRule = {
  trust_domains: RunnerTrustDomain[];
};

export type ExecutionCapabilityPolicy = {
  schema_version: 1;
  capabilities: Record<string, CapabilityRule>;
  operations: Record<ExecutionOperation, string[]>;
};

const capabilityPattern = /^[a-z][a-z0-9.-]{0,127}$/;
const operationSet = new Set<string>(executionOperations);
const trustSet = new Set<string>(runnerTrustDomains);

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((item, index) => item !== wanted[index])) {
    throw new CliError(`${label} keys are invalid.`, 65);
  }
}

function stringArray(value: unknown, label: string, pattern?: RegExp): string[] {
  if (!Array.isArray(value)
    || !value.every((item) => typeof item === "string" && (!pattern || pattern.test(item)))
    || new Set(value).size !== value.length
  ) {
    throw new CliError(`${label} must be a unique string array.`, 65);
  }
  return value as string[];
}

export function parseExecutionCapabilityPolicy(value: unknown): ExecutionCapabilityPolicy {
  if (!isJsonRecord(value) || value.schema_version !== 1
    || !isJsonRecord(value.capabilities) || !isJsonRecord(value.operations)
  ) {
    throw new CliError("Execution capability policy is invalid.", 65);
  }
  exactKeys(value, ["schema_version", "capabilities", "operations"], "Execution capability policy");

  const capabilities: Record<string, CapabilityRule> = {};
  for (const [name, raw] of Object.entries(value.capabilities)) {
    if (!capabilityPattern.test(name) || !isJsonRecord(raw)) {
      throw new CliError(`Execution capability is invalid: ${name}.`, 65);
    }
    exactKeys(raw, ["trust_domains"], `Execution capability ${name}`);
    const trustDomains = stringArray(raw.trust_domains, `Execution capability trust domains: ${name}`);
    if (trustDomains.length === 0 || !trustDomains.every((item) => trustSet.has(item))) {
      throw new CliError(`Execution capability trust domains are invalid: ${name}.`, 65);
    }
    capabilities[name] = { trust_domains: trustDomains as RunnerTrustDomain[] };
  }
  if (Object.keys(capabilities).length === 0) {
    throw new CliError("Execution capability policy must define capabilities.", 65);
  }

  const operationKeys = Object.keys(value.operations);
  if (operationKeys.length !== executionOperations.length
    || operationKeys.some((item) => !operationSet.has(item))
  ) {
    throw new CliError("Execution capability policy must define every operation exactly once.", 65);
  }

  const operations = {} as Record<ExecutionOperation, string[]>;
  for (const operation of executionOperations) {
    const allowed = stringArray(
      value.operations[operation],
      `Execution operation capabilities: ${operation}`,
      capabilityPattern,
    );
    if (allowed.some((capability) => !(capability in capabilities))) {
      throw new CliError(`Execution operation references an unknown capability: ${operation}.`, 65);
    }
    operations[operation] = allowed;
  }

  return { schema_version: 1, capabilities, operations };
}

export function validateExecutionGrant(
  policy: ExecutionCapabilityPolicy,
  operation: ExecutionOperation,
  job: ExecutionJob,
  trustDomain: RunnerTrustDomain,
): void {
  const allowed = new Set(policy.operations[operation]);
  for (const capability of job.capability_requests) {
    if (!allowed.has(capability)) {
      throw new CliError(
        `Capability is not allowed for operation ${operation}: ${capability}.`,
        77,
      );
    }
    const rule = policy.capabilities[capability];
    if (!rule?.trust_domains.includes(trustDomain)) {
      throw new CliError(
        `Capability cannot run in trust domain ${trustDomain}: ${capability}.`,
        77,
      );
    }
  }
}
