import {
  getJsonString,
  isJsonRecord,
} from "./github-api.ts";
import { CliError } from "./runtime-command.ts";

export type SecurityScanManifest = {
  schema_version: "1";
  engine: "codeql";
  runner_profile: string;
  build_mode: "none" | "autobuild";
  languages: string[];
  pull_requests: boolean;
  default_branch: boolean;
};

export type SecurityScanRequest = {
  schema_version: "1";
  request_id: string;
  repository: string;
  source_sha: string;
  pr_number: number;
};

export type SecurityScanFacts = {
  repository: string;
  source_sha: string;
  pr_number: number;
  config_ref: string;
  ref: string;
  default_branch: string;
  is_private: boolean;
};

type GithubGet = {
  get(path: string): Promise<unknown>;
};

const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const requestPattern = /^[A-Za-z0-9._:-]{1,128}$/;
const shaPattern = /^[0-9a-f]{40}$/;
const runnerPattern = /^[a-z][a-z0-9-]{0,63}$/;
const languages = new Set([
  "c-cpp",
  "csharp",
  "go",
  "java-kotlin",
  "javascript-typescript",
  "python",
  "ruby",
  "rust",
  "swift",
]);
const buildModes = new Set(["none", "autobuild"]);

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((item, index) => item !== wanted[index])) {
    throw new CliError(`${label} keys are invalid.`, 65);
  }
}

export function decodeGithubContent(value: unknown): string {
  if (!isJsonRecord(value) || value.encoding !== "base64" || typeof value.content !== "string") {
    throw new CliError("GitHub contents response is invalid.", 65);
  }
  return Buffer.from(value.content.replace(/\s+/g, ""), "base64").toString("utf8");
}

export function parseSecurityScanManifest(value: unknown): SecurityScanManifest {
  if (!isJsonRecord(value)) {
    throw new CliError("Security scan manifest must be an object.", 65);
  }
  exactKeys(
    value,
    [
      "build_mode",
      "default_branch",
      "engine",
      "languages",
      "pull_requests",
      "runner_profile",
      "schema_version",
    ],
    "Security scan manifest",
  );
  if (value.schema_version !== "1"
    || value.engine !== "codeql"
    || typeof value.runner_profile !== "string"
    || !runnerPattern.test(value.runner_profile)
    || typeof value.build_mode !== "string"
    || !buildModes.has(value.build_mode)
    || !Array.isArray(value.languages)
    || value.languages.length < 1
    || value.languages.length > 9
    || !value.languages.every((item) => typeof item === "string" && languages.has(item))
    || new Set(value.languages).size !== value.languages.length
    || typeof value.pull_requests !== "boolean"
    || typeof value.default_branch !== "boolean"
  ) {
    throw new CliError("Security scan manifest is invalid.", 65);
  }
  return value as unknown as SecurityScanManifest;
}

export function parseSecurityScanRequest(value: unknown): SecurityScanRequest {
  if (!isJsonRecord(value)) {
    throw new CliError("Security scan request must be an object.", 64);
  }
  exactKeys(
    value,
    ["pr_number", "repository", "request_id", "schema_version", "source_sha"],
    "Security scan request",
  );
  if (value.schema_version !== "1"
    || typeof value.request_id !== "string"
    || !requestPattern.test(value.request_id)
    || typeof value.repository !== "string"
    || !repositoryPattern.test(value.repository)
    || typeof value.source_sha !== "string"
    || !shaPattern.test(value.source_sha)
    || !Number.isInteger(value.pr_number)
    || Number(value.pr_number) < 0
  ) {
    throw new CliError("Security scan request is invalid.", 64);
  }
  return value as unknown as SecurityScanRequest;
}

export async function resolveSecurityScanFacts(
  reader: GithubGet,
  request: SecurityScanRequest,
): Promise<SecurityScanFacts> {
  const repositoryValue = await reader.get(`repos/${request.repository}`);
  if (!isJsonRecord(repositoryValue)) {
    throw new CliError("GitHub repository response is invalid.", 65);
  }
  const defaultBranch = getJsonString(repositoryValue, "default_branch");
  const isPrivate = repositoryValue.private;
  if (!defaultBranch || typeof isPrivate !== "boolean") {
    throw new CliError("Repository default branch or visibility is unavailable.", 65);
  }

  if (request.pr_number > 0) {
    const pull = await reader.get(`repos/${request.repository}/pulls/${request.pr_number}`);
    if (!isJsonRecord(pull) || !isJsonRecord(pull.head) || !isJsonRecord(pull.base)) {
      throw new CliError("GitHub pull request response is invalid.", 65);
    }
    const headSha = getJsonString(pull.head, "sha");
    const baseSha = getJsonString(pull.base, "sha");
    if (headSha !== request.source_sha || !shaPattern.test(baseSha)) {
      throw new CliError("Security scan request is stale or has an invalid PR base SHA.", 75);
    }
    return {
      repository: request.repository,
      source_sha: request.source_sha,
      pr_number: request.pr_number,
      config_ref: baseSha,
      ref: `refs/pull/${request.pr_number}/head`,
      default_branch: defaultBranch,
      is_private: isPrivate,
    };
  }

  const commit = await reader.get(`repos/${request.repository}/commits/${defaultBranch}`);
  if (!isJsonRecord(commit)) {
    throw new CliError("GitHub default branch commit response is invalid.", 65);
  }
  const defaultSha = getJsonString(commit, "sha");
  if (defaultSha !== request.source_sha) {
    throw new CliError("Security scan request is stale; default branch has moved.", 75);
  }
  return {
    repository: request.repository,
    source_sha: request.source_sha,
    pr_number: 0,
    config_ref: request.source_sha,
    ref: `refs/heads/${defaultBranch}`,
    default_branch: defaultBranch,
    is_private: isPrivate,
  };
}

export function scanEnabled(manifest: SecurityScanManifest, prNumber: number): boolean {
  return prNumber > 0 ? manifest.pull_requests : manifest.default_branch;
}
