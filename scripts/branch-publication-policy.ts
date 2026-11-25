import { CliError } from "./runtime-command.ts";

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
