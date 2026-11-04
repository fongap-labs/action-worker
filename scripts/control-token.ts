/**
 * Operation-specific credentials. App API tokens are minted by trusted workflows and are
 * intentionally kept separate from the HMAC signing key, control-plane reads and checkout token.
 *
 * GitHub App token permissions:
 * - AW_STATUS_API_TOKEN   Commit statuses: scoped read or write
 * - AW_ISSUE_API_TOKEN    Issues: scoped write
 * - AW_DISPATCH_API_TOKEN Contents: write on fongap-labs/action-worker
 * - AW_CHECKOUT_TOKEN Contents: Read on private target repositories
 * - AW_RELEASE_API_TOKEN Contents: Read on the explicit release target
 * - AW_CONTROL_TOKEN  Only the remaining control-plane permissions
 *
 * App tokens are short-lived and repository-scoped. Missing operation tokens never fall back to
 * GH_TOKEN, AW_CONTROL_TOKEN, a signing key or a token minted for a different operation.
 */

import { CliError } from "./runtime-command.ts";

export type TokenScope =
  | "status"
  | "issue"
  | "dispatch"
  | "checkout"
  | "release"
  | "branch"
  | "control";

const scopeEnv: Record<TokenScope, string> = {
  status: "AW_STATUS_API_TOKEN",
  issue: "AW_ISSUE_API_TOKEN",
  dispatch: "AW_DISPATCH_API_TOKEN",
  checkout: "AW_CHECKOUT_TOKEN",
  release: "AW_RELEASE_API_TOKEN",
  branch: "AW_BRANCH_API_TOKEN",
  control: "AW_CONTROL_TOKEN",
};

const scopePermissions: Record<TokenScope, string> = {
  status: "a scoped GitHub App token with Commit statuses read or write",
  issue: "a scoped GitHub App token with Issues write",
  dispatch: "a GitHub App token with Contents write on fongap-labs/action-worker",
  checkout: "Contents: Read on the private target repositories",
  release: "a scoped GitHub App token with Contents: Read on the release target",
  branch:
    "a scoped GitHub App token with Contents: Write and Pull requests: Read on managed repositories",
  control: "the permissions required by the control-plane operation",
};

export function scopeEnvName(scope: TokenScope): string {
  return scopeEnv[scope];
}

export function resolveToken(scope: TokenScope, env: NodeJS.ProcessEnv = process.env): string {
  return env[scopeEnv[scope]] ?? "";
}

export function requireToken(scope: TokenScope, env: NodeJS.ProcessEnv = process.env): string {
  const value = resolveToken(scope, env);
  if (!value) {
    throw new CliError(
      `::error::Missing required ${scopeEnv[scope]}. Grant ${scopePermissions[scope]} in the calling workflow. No token fallback is permitted.`,
      77
    );
  }
  return value;
}

/** Backward-compatible name for API readers; this is never signing material. */
export function requireStatusToken(env: NodeJS.ProcessEnv = process.env): string {
  return requireToken("status", env);
}
