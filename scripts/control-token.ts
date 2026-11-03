/**
 * Dedicated GitHub credentials. A missing scoped secret must never be replaced with
 * GH_TOKEN, AW_CONTROL_TOKEN, or a token for a different operation.
 *
 * Fine-grained PAT repository permissions:
 * - AW_STATUS_TOKEN   Commit statuses: Read and write on managed repositories
 * - AW_ISSUE_TOKEN    Issues: Read and write on managed repositories
 * - AW_DISPATCH_TOKEN Contents: Read and write on fongap-labs/action-worker
 * - AW_CHECKOUT_TOKEN Contents: Read on private target repositories
 * - AW_CONTROL_TOKEN  Only the remaining control-plane permissions
 *
 * Tokens owned by one GitHub account share its API rate-limit pool. Splitting
 * credentials restricts authorization; it does not increase the shared quota.
 */

import { CliError } from "./runtime-command.ts";

export type TokenScope = "status" | "issue" | "dispatch" | "checkout" | "control";

const scopeEnv: Record<TokenScope, string> = {
  status: "AW_STATUS_TOKEN",
  issue: "AW_ISSUE_TOKEN",
  dispatch: "AW_DISPATCH_TOKEN",
  checkout: "AW_CHECKOUT_TOKEN",
  control: "AW_CONTROL_TOKEN",
};

const scopePermissions: Record<TokenScope, string> = {
  status: "Commit statuses: Read and write on managed repositories",
  issue: "Issues: Read and write on managed repositories",
  dispatch: "Contents: Read and write on fongap-labs/action-worker",
  checkout: "Contents: Read on the private target repositories",
  control: "the permissions required by the control-plane operation",
};

export function scopeEnvName(scope: TokenScope): string {
  return scopeEnv[scope];
}

export function resolveToken(
  scope: TokenScope,
  env: NodeJS.ProcessEnv = process.env
): string {
  return env[scopeEnv[scope]] ?? "";
}

export function requireToken(
  scope: TokenScope,
  env: NodeJS.ProcessEnv = process.env
): string {
  const value = resolveToken(scope, env);
  if (!value) {
    throw new CliError(
      `::error::Missing required GitHub secret ${scopeEnv[scope]}. Grant ${scopePermissions[scope]}. Configure: fongap-labs/action-worker → Settings → Secrets and variables → Actions. No token fallback is permitted.`,
      77
    );
  }
  return value;
}
