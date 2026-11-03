/**
 * Control-plane token scopes (strict mode: no fallback to AW_CONTROL_TOKEN).
 *
 * Each scope maps to one secret. A scoped secret that is not configured is a hard
 * failure: operations never silently fall back to AW_CONTROL_TOKEN.
 *
 * Workflows inject the scoped secret via `GH_TOKEN: ${{ secrets.AW_STATUS_TOKEN }}`
 * (and similar). Scripts read it through resolveToken(scope), which accepts the scope's
 * own env var first, then GH_TOKEN (set by the workflow to the scoped secret). Neither
 * path falls back to AW_CONTROL_TOKEN.
 *
 * Scope map:
 * - AW_STATUS_TOKEN     → Commit statuses Read/Write + Actions Read (verifies control runs)
 * - AW_ISSUE_TOKEN      → Issues Read/Write (incidents, PR comments)
 * - AW_DISPATCH_TOKEN   → Contents Read/Write on the action-worker repository (self-dispatch)
 * - AW_CHECKOUT_TOKEN   → Contents Read, private managed repos only (already existed)
 * - AW_CONTROL_TOKEN    → broad control-plane reads: pull requests, actions runs, repo metadata
 *
 * Rate-limit note: classic/fine-grained PATs from the same GitHub account share a single
 * 5000/hr pool. Token splitting reduces blast radius (leak/revoke impact) and enforces least
 * privilege; it does not raise the ceiling. Use GitHub Apps for multiple pools.
 */

import { CliError } from "./runtime-command.ts";

export type TokenScope =
  | "status"
  | "issue"
  | "dispatch"
  | "checkout"
  | "control";

const scopeEnv: Record<TokenScope, string> = {
  status: "AW_STATUS_TOKEN",
  issue: "AW_ISSUE_TOKEN",
  dispatch: "AW_DISPATCH_TOKEN",
  checkout: "AW_CHECKOUT_TOKEN",
  control: "AW_CONTROL_TOKEN",
};

export function scopeEnvName(scope: TokenScope): string {
  return scopeEnv[scope];
}

// Returns the token for the scope: the scope's own env var first, then GH_TOKEN (which
// workflows set to the scoped secret). Never falls back to AW_CONTROL_TOKEN.
export function resolveToken(scope: TokenScope): string {
  const primary = process.env[scopeEnv[scope]] ?? "";
  if (primary) return primary;
  return process.env.GH_TOKEN ?? "";
}

export function requireToken(scope: TokenScope): string {
  const token = resolveToken(scope);
  if (!token) {
    throw new CliError(
      `::error::${scopeEnv[scope]} is required for scope "${scope}" and is not configured. ` +
        "Configure it in the repository secrets; scoped operations do not fall back to AW_CONTROL_TOKEN.",
      77
    );
  }
  return token;
}
