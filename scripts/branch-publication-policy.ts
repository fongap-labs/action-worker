import { readFileSync } from "node:fs";
import { getGithubJsonIfExists, getJsonString, isJsonRecord } from "./github-api.ts";
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

export async function resolveOrdinaryDevelopmentBranch(
  get: (path: string) => Promise<unknown>,
  repository: string,
  policy: unknown
): Promise<{ branch: "main" | "dev"; sha: string; tree: string }> {
  const isEnabled = isDevEnabled(policy, repository);
  const prefix = "repos/" + repository + "/branches/";
  const main = await get(prefix + "main");
  const dev = await getGithubJsonIfExists(prefix + "dev", get);
  function snapshot(value: unknown, branch: "main" | "dev") {
    if (!isJsonRecord(value) || value.name !== branch || !isJsonRecord(value.commit)) {
      throw new CliError("Managed branch snapshot is unavailable.", 75);
    }
    const sha = getJsonString(value.commit, "sha");
    const treeSha = isJsonRecord(value.commit.commit)
      ? getJsonString(value.commit.commit.tree, "sha")
      : "";
    if (!/^[a-f0-9]{40}$/.test(sha) || !/^[a-f0-9]{40}$/.test(treeSha)) {
      throw new CliError("Managed branch snapshot is invalid.", 75);
    }
    return { branch, sha, tree: treeSha };
  }
  const stable = snapshot(main, "main");
  if (dev === undefined) return stable;
  if (!isEnabled) throw new CliError("Existing dev is disabled; resolve branch policy first.", 77);
  return snapshot(dev, "dev");
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
