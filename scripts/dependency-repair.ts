import {
  getJsonArray,
  getJsonString,
  isJsonRecord,
} from "./github-api.ts";
import { CliError } from "./runtime-command.ts";

export type DependencyRepairAdapter = "uv-lock";

export type DependencyRepairRule = {
  id: string;
  adapter: DependencyRepairAdapter;
  runner_profile: string;
  trusted_actor: string;
  trigger_paths: string[];
  output_paths: string[];
  tool_version: string;
  head_prefix: string;
  working_directory: string;
};

export type DependencyRepairManifest = {
  schema_version: "1";
  repairs: DependencyRepairRule[];
};

export type DependencyRepairRequest = {
  schema_version: "1";
  request_id: string;
  repository: string;
  pr_number: number;
  head_sha: string;
};

export type DependencyRepairFacts = {
  repository: string;
  pr_number: number;
  head_sha: string;
  head_ref: string;
  base_sha: string;
  actor: string;
  changed_paths: string[];
};

type GithubGet = {
  get(path: string): Promise<unknown>;
};

const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const requestPattern = /^[A-Za-z0-9._:-]{1,128}$/;
const shaPattern = /^[0-9a-f]{40}$/;
const idPattern = /^[a-z][a-z0-9-]{0,63}$/;
const runnerPattern = /^[a-z][a-z0-9-]{0,63}$/;
const versionPattern = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const branchPrefixPattern = /^[A-Za-z0-9._/-]{1,128}$/;

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((item, index) => item !== wanted[index])) {
    throw new CliError(`${label} keys are invalid.`, 65);
  }
}

function safeRelativePath(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 512
    && !value.startsWith("/")
    && !/^[A-Za-z]:[\\/]/.test(value)
    && !value.split(/[\\/]+/).includes("..")
    && /^[A-Za-z0-9._/-]+$/.test(value);
}

function stringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value)
    || value.length < 1
    || value.length > 32
    || !value.every(safeRelativePath)
    || new Set(value).size !== value.length
  ) {
    throw new CliError(`${label} must be a unique relative-path array.`, 65);
  }
  return value as string[];
}

export function decodeGithubContent(value: unknown): string {
  if (!isJsonRecord(value) || value.encoding !== "base64" || typeof value.content !== "string") {
    throw new CliError("GitHub contents response is invalid.", 65);
  }
  return Buffer.from(value.content.replace(/\s+/g, ""), "base64").toString("utf8");
}

export function parseDependencyRepairManifest(value: unknown): DependencyRepairManifest {
  if (!isJsonRecord(value)) {
    throw new CliError("Dependency repair manifest must be an object.", 65);
  }
  exactKeys(value, ["repairs", "schema_version"], "Dependency repair manifest");
  if (value.schema_version !== "1"
    || !Array.isArray(value.repairs)
    || value.repairs.length < 1
    || value.repairs.length > 16
  ) {
    throw new CliError("Dependency repair manifest is invalid.", 65);
  }

  const ids = new Set<string>();
  const repairs = value.repairs.map((raw): DependencyRepairRule => {
    if (!isJsonRecord(raw)) {
      throw new CliError("Dependency repair rule must be an object.", 65);
    }
    exactKeys(
      raw,
      [
        "adapter",
        "head_prefix",
        "id",
        "output_paths",
        "runner_profile",
        "tool_version",
        "trigger_paths",
        "trusted_actor",
        "working_directory",
      ],
      "Dependency repair rule",
    );
    if (typeof raw.id !== "string" || !idPattern.test(raw.id)
      || raw.adapter !== "uv-lock"
      || typeof raw.runner_profile !== "string" || !runnerPattern.test(raw.runner_profile)
      || typeof raw.trusted_actor !== "string" || raw.trusted_actor.length < 1 || raw.trusted_actor.length > 128
      || typeof raw.tool_version !== "string" || !versionPattern.test(raw.tool_version)
      || typeof raw.head_prefix !== "string" || !branchPrefixPattern.test(raw.head_prefix)
      || !safeRelativePath(raw.working_directory)
    ) {
      throw new CliError("Dependency repair rule is invalid.", 65);
    }
    if (ids.has(raw.id)) {
      throw new CliError(`Duplicate dependency repair id: ${raw.id}.`, 65);
    }
    ids.add(raw.id);

    const triggerPaths = stringList(raw.trigger_paths, `trigger_paths for ${raw.id}`);
    const outputPaths = stringList(raw.output_paths, `output_paths for ${raw.id}`);
    if (triggerPaths.some((path) => outputPaths.includes(path))) {
      throw new CliError(`Dependency repair input and output paths overlap: ${raw.id}.`, 65);
    }
    return {
      id: raw.id,
      adapter: raw.adapter,
      runner_profile: raw.runner_profile,
      trusted_actor: raw.trusted_actor,
      trigger_paths: triggerPaths,
      output_paths: outputPaths,
      tool_version: raw.tool_version,
      head_prefix: raw.head_prefix,
      working_directory: raw.working_directory,
    };
  });

  return { schema_version: "1", repairs };
}

export function parseDependencyRepairRequest(value: unknown): DependencyRepairRequest {
  if (!isJsonRecord(value)) {
    throw new CliError("Dependency repair request must be an object.", 64);
  }
  exactKeys(
    value,
    ["head_sha", "pr_number", "repository", "request_id", "schema_version"],
    "Dependency repair request",
  );
  if (value.schema_version !== "1"
    || typeof value.request_id !== "string" || !requestPattern.test(value.request_id)
    || typeof value.repository !== "string" || !repositoryPattern.test(value.repository)
    || !Number.isInteger(value.pr_number) || Number(value.pr_number) < 1
    || typeof value.head_sha !== "string" || !shaPattern.test(value.head_sha)
  ) {
    throw new CliError("Dependency repair request is invalid.", 64);
  }
  return value as DependencyRepairRequest;
}

function pullFacts(value: unknown, request: DependencyRepairRequest): Omit<DependencyRepairFacts, "changed_paths"> {
  if (!isJsonRecord(value)
    || getJsonString(value, "state") !== "open"
    || !isJsonRecord(value.head)
    || !isJsonRecord(value.base)
    || !isJsonRecord(value.user)
  ) {
    throw new CliError("Dependency repair requires an open pull request.", 75);
  }

  const headSha = getJsonString(value.head, "sha");
  const headRef = getJsonString(value.head, "ref");
  const baseSha = getJsonString(value.base, "sha");
  const actor = getJsonString(value.user, "login");
  const headRepo = isJsonRecord(value.head.repo) ? getJsonString(value.head.repo, "full_name") : "";

  if (headSha !== request.head_sha
    || !shaPattern.test(baseSha)
    || !headRef
    || !actor
    || headRepo !== request.repository
  ) {
    throw new CliError("Dependency repair request is stale or targets a forked PR.", 75);
  }

  return {
    repository: request.repository,
    pr_number: request.pr_number,
    head_sha: headSha,
    head_ref: headRef,
    base_sha: baseSha,
    actor,
  };
}

async function changedPaths(reader: GithubGet, repository: string, prNumber: number): Promise<string[]> {
  const paths: string[] = [];
  for (let page = 1; page <= 20; page += 1) {
    const files = getJsonArray(
      await reader.get(`repos/${repository}/pulls/${prNumber}/files?per_page=100&page=${page}`),
    );
    for (const file of files) {
      const filename = getJsonString(file, "filename");
      if (!safeRelativePath(filename)) {
        throw new CliError("Dependency repair PR contains an invalid file path.", 65);
      }
      paths.push(filename);
    }
    if (files.length < 100) break;
  }
  return [...new Set(paths)].sort();
}

export async function resolveDependencyRepairFacts(
  reader: GithubGet,
  request: DependencyRepairRequest,
): Promise<DependencyRepairFacts> {
  const pull = await reader.get(`repos/${request.repository}/pulls/${request.pr_number}`);
  const facts = pullFacts(pull, request);
  return {
    ...facts,
    changed_paths: await changedPaths(reader, request.repository, request.pr_number),
  };
}

export function selectDependencyRepair(
  manifest: DependencyRepairManifest,
  facts: DependencyRepairFacts,
): DependencyRepairRule | null {
  const matches = manifest.repairs.filter((repair) =>
    repair.trusted_actor === facts.actor
    && facts.head_ref.startsWith(repair.head_prefix)
    && repair.trigger_paths.some((path) => facts.changed_paths.includes(path))
  );
  if (matches.length > 1) {
    throw new CliError("Multiple dependency repair rules match the same pull request.", 65);
  }
  return matches[0] ?? null;
}
