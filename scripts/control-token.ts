/**
 * Control-plane token scopes.
 *
 * All tokens default to AW_CONTROL_TOKEN for backward compatibility. Configure the
 * scoped secrets in GitHub Actions settings to enable isolation.
 *
 * Scope map:
 * - AW_STATUS_TOKEN     → repo:status (read/write commit statuses)
 * - AW_ISSUE_TOKEN      → repo:issues (read/write issues)
 * - AW_DISPATCH_TOKEN   → repo:dispatch (repository_dispatch events)
 * - AW_CHECKOUT_TOKEN   → contents:read (private repo checkout, already exists)
 * - AW_CONTROL_TOKEN    → full control-plane access (fallback for all)
 *
 * Rate-limit note: classic/fine-grained PATs from the same GitHub account share
 * a single 5000/hr pool. Token splitting primarily reduces blast radius (leak/revoke
 * impact) and enforces least privilege, NOT aggregate rate-limit expansion.
 * Use GitHub Apps for true multi-pool rate limits.
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

export function scopeEnvName(scope: TokenScope): string {
  return scopeEnv[scope];
}

// Returns the scoped token, or GH_TOKEN (standard workflow env var), or the control token when the scoped one is not configured.
// Returns an empty string when neither is available.
export function resolveToken(scope: TokenScope, fallbackScope: TokenScope = "control"): string {
  const primary = process.env[scopeEnv[scope]] ?? "";
  if (primary) return primary;
  // GH_TOKEN is the standard env var passed by workflows for status/dispatch operations.
  // Many workflows pass GH_TOKEN = AW_CONTROL_TOKEN. Accept it as a fallback.
  if ((scope === "status" || scope === "dispatch") && process.env.GH_TOKEN) {
    return process.env.GH_TOKEN;
  }
  return process.env[scopeEnv[fallbackScope]] ?? "";
}

export function requireToken(scope: TokenScope, fallbackScope: TokenScope = "control"): string {
  const token = resolveToken(scope, fallbackScope);
  if (!token) {
    throw new CliError(
      `::error::${scopeEnv[scope]} is required for this operation (or ${scopeEnv[fallbackScope]} as fallback).`,
      77
    );
  }
  return token;
}
