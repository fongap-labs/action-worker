import { readFileSync } from "node:fs";
import { isJsonRecord } from "./github-api.ts";
import { CliError } from "./runtime-command.ts";

export function readBranchPolicy(): unknown {
  return JSON.parse(readFileSync(new URL("../policies/rulesets.json", import.meta.url), "utf8"));
}

export function isDevEnabled(policy: unknown, repository: string): boolean {
  if (
    !isJsonRecord(policy) ||
    (policy.dev_merge_mode !== "automatic" && policy.dev_merge_mode !== "closed")
  ) {
    throw new CliError("Invalid development enrollment mode.", 65);
  }
  const disabled = policy.dev_disabled_repositories;
  if (
    !Array.isArray(disabled) ||
    !disabled.every(
      (name) => typeof name === "string" && /^fongap-labs\/[A-Za-z0-9_.-]+$/.test(name)
    ) ||
    new Set(disabled).size !== disabled.length
  ) {
    throw new CliError("Invalid disabled development repository policy.", 65);
  }
  return (
    policy.dev_merge_mode === "automatic" &&
    /^fongap-labs\/[A-Za-z0-9_.-]+$/.test(repository) &&
    !disabled.includes(repository)
  );
}

// The three-component build version and legacy four-component artifact version are both supported.
const stableVersion = /^[0-9]+\.[0-9]+\.[0-9]+(?:\.[0-9]+)?$/;
const betaVersion = /^[0-9]+\.[0-9]+\.[0-9]+(?:\.[0-9]+)?-beta\.[1-9][0-9]*$/;

export function assertBranchReleaseVersion(
  branch: string,
  version: string,
  isPrerelease: boolean
): void {
  const normalized = version.replace(/^v/, "");
  if (branch === "main" && !isPrerelease && stableVersion.test(normalized)) return;
  if (branch === "dev" && isPrerelease && betaVersion.test(normalized)) return;
  throw new CliError(
    "Release channel mismatch: main requires stable; dev requires Beta and prerelease.",
    65
  );
}

/** Validate the actual Git tag, not just the manifest's claimed version or channel. */
export function assertBranchReleaseTag(
  branch: string,
  releaseKey: string,
  version: string,
  isPrerelease: boolean,
  tag: string
): void {
  assertBranchReleaseVersion(branch, version, isPrerelease);
  if (
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(releaseKey) ||
    tag !== `${releaseKey}-v${version}` ||
    !(branch === "dev" ? betaVersion : stableVersion).test(version)
  ) {
    throw new CliError("Release tag does not match the verified branch and version.", 65);
  }
}

export function assertBranchDeployEnvironment(branch: string, environment: string): void {
  if (
    (branch === "main" && environment === "production") ||
    (branch === "dev" && environment === "beta")
  ) {
    return;
  }
  throw new CliError("Deploy channel mismatch: main requires production; dev requires beta.", 65);
}

/** Existing privileged paths are main-only until dev execution and credentials are authorized. */
export function assertMainPublicationBranch(branch: string): void {
  if (branch !== "main") {
    throw new CliError("Publication requires the managed main branch; dev is not enabled.", 75);
  }
}

/** Artifact names are scoped to their channel, with the dev prefix reserved. */
export function branchReleaseArtifactName(branch: string, name: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name.startsWith("dev-beta-")) {
    throw new CliError("Release artifact name is invalid or reserved.", 65);
  }
  const result = branch === "dev" ? `dev-beta-${name}` : name;
  if ((branch !== "main" && branch !== "dev") || result.length > 128) {
    throw new CliError("Release artifact channel or name length is invalid.", 65);
  }
  return result;
}
