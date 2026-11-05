import { readFile } from "node:fs/promises";
import { GithubReader, isJsonRecord } from "./github-api.ts";
import { CliError, handleError, isMain } from "./runtime-command.ts";

// The target list is discovery scope only; it is not a repository authorization policy.
// AW_REPOSITORY_POLICY and the existing task/deploy policy files remain authoritative.
export type ConfigAuditSummary = {
  schema_version: 1;
  mode: "read-only-source";
  repositories_scanned: number;
  public_repositories: number;
  private_repositories: number;
  source_manifests: number;
  declared_secret_names: number;
  declared_variable_names: number;
  variable_policy_status: "not-defined-by-task-secret-policy";
  policy_excess_names: number;
  invalid_declarations: number;
  credential_type_review_candidates: number;
  storage_presence: "unverified";
  organization_inheritance: "unverified";
  environment_protection: "unverified";
  consumer_behavior: "unverified";
  automatic_writes: false;
};

const repositoryPattern = /^fongap-labs\/[A-Za-z0-9_.-]+$/;
const secretNamePattern = /^[A-Z][A-Z0-9_]*$/;
const declarationPattern =
  /^projects\/([A-Za-z0-9][A-Za-z0-9_.-]*)\/\.(secrets|vars)\.(required|allowed)$/;

export function parseSecretNames(input: string): { names: string[]; invalid: number } {
  const names = new Set<string>();
  let invalid = 0;
  for (const raw of input.split(/\r?\n/)) {
    const name = raw.replace(/#.*/, "").trim();
    if (name === "") continue;
    if (!secretNamePattern.test(name) || /^(AW_|GITHUB_|RUNNER_|ACTIONS_)/.test(name)) {
      invalid++;
      continue;
    }
    if (names.has(name)) invalid++;
    names.add(name);
  }
  return { names: [...names], invalid };
}

export function sourceManifest(
  path: string
): { project: string; dataClass: "secret" | "variable"; kind: string } | null {
  const match = declarationPattern.exec(path);
  if (!match?.[1] || !match[2] || !match[3]) return null;
  return { project: match[1], dataClass: match[2] === "secrets" ? "secret" : "variable", kind: match[3] };
}

export function policyDeclarationCheck(
  declared: readonly string[],
  policy: unknown,
  repository: string,
  project: string
): { excess: number; typeReview: number } {
  const tasks = isJsonRecord(policy) ? policy.tasks : undefined;
  const repoPolicy = isJsonRecord(tasks) ? tasks[repository] : undefined;
  const projectPolicy = isJsonRecord(repoPolicy) ? repoPolicy[project] : undefined;
  const allow = new Set<string>();
  if (isJsonRecord(projectPolicy)) {
    for (const field of ["required", "allowed"]) {
      const values = projectPolicy[field];
      if (Array.isArray(values)) {
        for (const value of values) if (typeof value === "string") allow.add(value);
      }
    }
  }
  const aliases = isJsonRecord(projectPolicy) ? projectPolicy.aliases : undefined;
  let typeReview = 0;
  if (isJsonRecord(aliases)) {
    for (const [name, target] of Object.entries(aliases)) {
      if (/ACCESS_KEY/.test(name) && typeof target === "string" && /API_TOKEN/.test(target)) {
        typeReview++;
      }
    }
  }
  return { excess: declared.filter((name) => !allow.has(name)).length, typeReview };
}

function getText(value: unknown, key: string): string {
  if (!isJsonRecord(value) || typeof value[key] !== "string") {
    throw new CliError("Configuration audit received malformed GitHub metadata.", 65);
  }
  return value[key] as string;
}

function decodeBlob(value: unknown): string {
  if (!isJsonRecord(value) || value.encoding !== "base64") {
    throw new CliError("Configuration audit received an unsupported source file.", 65);
  }
  const contents = getText(value, "content").replace(/\s/g, "");
  // Bound source file size; never write source contents into public logs or artifacts.
  if (contents.length > 131072) {
    throw new CliError("Configuration audit source manifest is too large.", 65);
  }
  return Buffer.from(contents, "base64").toString("utf8");
}

export async function auditSources(
  reader: Pick<GithubReader, "get">,
  repositories: readonly string[],
  taskPolicy: unknown
): Promise<ConfigAuditSummary> {
  const summary: ConfigAuditSummary = {
    schema_version: 1,
    mode: "read-only-source",
    repositories_scanned: 0,
    public_repositories: 0,
    private_repositories: 0,
    source_manifests: 0,
    declared_secret_names: 0,
    policy_excess_names: 0,
    invalid_declarations: 0,
    credential_type_review_candidates: 0,
    storage_presence: "unverified",
    organization_inheritance: "unverified",
    environment_protection: "unverified",
    consumer_behavior: "unverified",
    automatic_writes: false,
  };
  for (const repository of repositories) {
    if (!repositoryPattern.test(repository)) {
      throw new CliError("Configuration audit target is invalid.", 65);
    }
    const metadata = await reader.get(`repos/${repository}`);
    if (!isJsonRecord(metadata) || typeof metadata.private !== "boolean") {
      throw new CliError("Configuration audit cannot determine repository visibility.", 65);
    }
    if (metadata.private) summary.private_repositories++;
    else summary.public_repositories++;

    const commit = await reader.get(`repos/${repository}/commits/main`);
    const sha = getText(commit, "sha");
    const commitDetails = isJsonRecord(commit) ? commit.commit : undefined;
    const treeDetails = isJsonRecord(commitDetails) ? commitDetails.tree : undefined;
    const treeSha = getText(treeDetails, "sha");
    if (!/^[a-f0-9]{40}$/.test(sha) || !/^[a-f0-9]{40}$/.test(treeSha)) {
      throw new CliError("Configuration audit received an invalid source SHA.", 65);
    }
    const tree = await reader.get(`repos/${repository}/git/trees/${treeSha}?recursive=1`);
    if (!isJsonRecord(tree) || tree.truncated !== false || !Array.isArray(tree.tree)) {
      throw new CliError("Configuration audit tree is incomplete.", 65);
    }
    // A source file is pinned by its blob SHA, not by a mutable main branch path.
    const entries = tree.tree as unknown[];
    const projects = new Map<string, Set<string>>();
    const variableProjects = new Map<string, Set<string>>();\n    const variableProjects = new Map<string, Set<string>>();
    for (const entry of entries) {
      if (!isJsonRecord(entry) || entry.type !== "blob") continue;
      const path = getText(entry, "path");
      const manifest = sourceManifest(path);
      if (!manifest) continue;
      const blobSha = getText(entry, "sha");
      if (!/^[a-f0-9]{40}$/.test(blobSha)) {
        throw new CliError("Configuration audit blob identity is invalid.", 65);
      }
      const value = await reader.get(`repos/${repository}/git/blobs/${blobSha}`);
      const parsed = parseSecretNames(decodeBlob(value));
      const target = manifest.dataClass === "secret" ? projects : variableProjects;
      const names = target.get(manifest.project) ?? new Set<string>();
      for (const name of parsed.names) names.add(name);
      target.set(manifest.project, names);
      summary.source_manifests++;
      summary.invalid_declarations += parsed.invalid;
    }
    for (const names of variableProjects.values()) {\n      summary.declared_variable_names += names.size;\n    }\n    for (const names of variableProjects.values()) {
      summary.declared_variable_names += names.size;
    }
    for (const [project, names] of projects) {
      const checked = policyDeclarationCheck([...names], taskPolicy, repository, project);
      summary.declared_secret_names += names.size;
      summary.policy_excess_names += checked.excess;
      summary.credential_type_review_candidates += checked.typeReview;
    }
    summary.repositories_scanned++;
  }
  return summary;
}

async function main(): Promise<void> {
  const token = process.env.AW_CONFIG_AUDIT_READ_TOKEN;
  if (!token) throw new CliError("A dedicated read-only audit token is required.", 77);
  const targets: unknown = JSON.parse(await readFile("policies/config-audit-targets.json", "utf8"));
  const policy: unknown = JSON.parse(await readFile("policies/task-secrets.json", "utf8"));
  if (
    !isJsonRecord(targets) ||
    targets.schema_version !== 1 ||
    !Array.isArray(targets.repositories)
  ) {
    throw new CliError("Configuration audit target declaration is invalid.", 65);
  }
  const repositories = targets.repositories;
  if (
    repositories.length !== new Set(repositories).size ||
    repositories.some((item) => typeof item !== "string" || !repositoryPattern.test(item))
  ) {
    throw new CliError(
      "Configuration audit target list contains invalid or duplicate repositories.",
      65
    );
  }
  const reader = new GithubReader(process.env.GITHUB_API_URL || "https://api.github.com", token, {
    attemptLimit: 3,
  });
  // All output is aggregate-only. Public control-repository logs must not reveal private config.
  try {
    console.log(
      JSON.stringify(await auditSources(reader, repositories as string[], policy), null, 2)
    );
  } catch {
    throw new CliError("Read-only configuration audit incomplete; no results published.", 77);
  }
}

if (isMain(import.meta.url)) main().catch(handleError);
