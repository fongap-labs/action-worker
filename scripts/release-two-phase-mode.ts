import { CliError } from "./runtime-command.ts";

export type TwoPhaseReleasePolicy = {
  schema_version: 1;
  approved_staging_repositories: string[];
};

export type ReleasePhaseSelection =
  | { kind: "read-only" }
  | { kind: "staging"; prToken: string; timeoutMinutes: number };

const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
export const stagingReleaseTimeoutMinutes = 12;

/** Any future staging target must be explicitly reviewed and added to source-controlled policy. */
export function parseTwoPhaseReleasePolicy(value: unknown): TwoPhaseReleasePolicy {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CliError("::error::Two-phase Release staging policy is invalid.", 65);
  }
  const data = value as Record<string, unknown>;
  const targets = data.approved_staging_repositories;
  if (
    data.schema_version !== 1 ||
    !Array.isArray(targets) ||
    targets.some((item) => typeof item !== "string" || !repositoryPattern.test(item)) ||
    new Set(targets).size !== targets.length
  ) {
    throw new CliError("::error::Two-phase Release staging policy is invalid.", 65);
  }
  return { schema_version: 1, approved_staging_repositories: targets as string[] };
}

/**
 * The current protected release workflow supplies no opt-in mode or PR write token.
 * Even a manually set mode is refused until a separately reviewed policy change
 * grants exactly one staging target and the operator provides a scoped token.
 */
export function selectReleasePhase(
  input: {
    mode: string | undefined;
    targetRepository: string;
    prToken: string | undefined;
  },
  policy: TwoPhaseReleasePolicy
): ReleasePhaseSelection {
  if (input.mode === undefined || input.mode === "" || input.mode === "read-only") {
    return { kind: "read-only" };
  }
  if (input.mode !== "staging") {
    throw new CliError("::error::Unknown two-phase Release mode; publication refused.", 64);
  }
  if (!policy.approved_staging_repositories.includes(input.targetRepository)) {
    throw new CliError(
      "::error::Two-phase Release is disabled for this target; a reviewed staging allowlist is required.",
      77
    );
  }
  if (!input.prToken) {
    throw new CliError(
      "::error::A dedicated target-scoped PR write token is required for staged two-phase Release.",
      77
    );
  }
  return {
    kind: "staging",
    prToken: input.prToken,
    timeoutMinutes: stagingReleaseTimeoutMinutes,
  };
}
