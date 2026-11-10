import { parseRepositoryPolicy } from "./repository-policy.ts";
import { CliError } from "./runtime-command.ts";

const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/**
 * Repository dispatch carries a wake-up hint, never an authorization grant.
 * A known policy member narrows redundant event-triggered scans; cron always
 * passes an empty hint and therefore continues a complete reconciliation.
 * Unknown members retain full-scan compatibility with newly enrolled repos.
 */
export function trustedIntakeTarget(policyValue: unknown, requested: string): string {
  if (!requested) return "";
  const [owner = "", name = ""] = requested.split("/");
  if (
    !repositoryPattern.test(requested) ||
    owner === "." ||
    owner === ".." ||
    name === "." ||
    name === ".."
  ) {
    throw new CliError("Intake wake-up repository must be owner/repository.", 64);
  }
  const policy = parseRepositoryPolicy(policyValue);
  return Object.hasOwn(policy, requested) ? requested : "";
}
