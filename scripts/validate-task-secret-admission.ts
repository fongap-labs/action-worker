import { GithubReader, isJsonRecord } from "./github-api.ts";
import { CliError, handleError, isMain } from "./runtime-command.ts";
import { readSecretAliases, readTaskSecretCeiling } from "./resolve-secret-scope.ts";

// Admission reads fixed Git blobs only. No task code runs and no secret value is available here.
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const projectPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const shaPattern = /^[a-f0-9]{40}$/;
const namePattern = /^[A-Z][A-Z0-9_]*$/;
const MAX_DECLARATION_BYTES = 16384;

export type TaskAdmissionResult = {
  required_count: number;
  allowed_count: number;
  aliased_count: number;
  secret_values_read: false;
  repository_policy_modified: false;
};

type Reader = Pick<GithubReader, "get">;

function reserved(name: string): boolean {
  return (
    /^(?:AW_|GITHUB_|RUNNER_|ACTIONS_)/.test(name) || name === "GH_TOKEN" || name === "NODE_OPTIONS"
  );
}

export function parseTaskSecretDeclaration(contents: string): string[] {
  const seen = new Set<string>();
  for (const line of contents.split(/\r?\n/)) {
    const name = line.replace(/#.*/, "").trim();
    if (!name) continue;
    if (!namePattern.test(name) || reserved(name) || seen.has(name)) {
      throw new CliError("Task secret declaration contains an invalid or duplicate name.", 65);
    }
    seen.add(name);
  }
  return [...seen];
}

function blobContent(raw: unknown): string {
  if (
    !isJsonRecord(raw) ||
    raw.encoding !== "base64" ||
    typeof raw.content !== "string" ||
    raw.content.length > Math.ceil(MAX_DECLARATION_BYTES / 3) * 4 + 100
  ) {
    throw new CliError("Task secret declaration blob metadata is invalid.", 65);
  }
  const base64 = raw.content.replace(/\s/g, "");
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) {
    throw new CliError("Task secret declaration blob encoding is invalid.", 65);
  }
  const contents = Buffer.from(base64, "base64");
  if (contents.length > MAX_DECLARATION_BYTES || contents.toString("base64") !== base64) {
    throw new CliError("Task secret declaration exceeds the size limit.", 65);
  }
  const decoded = contents.toString("utf8");
  if (!Buffer.from(decoded, "utf8").equals(contents)) {
    throw new CliError("Task secret declaration must use valid UTF-8.", 65);
  }
  return decoded;
}

export async function validateTaskSecretAdmission(
  reader: Reader,
  repository: string,
  project: string,
  ref: string,
  policyPath = "policies/task-secrets.json"
): Promise<TaskAdmissionResult> {
  if (
    !repositoryPattern.test(repository) ||
    !projectPattern.test(project) ||
    !shaPattern.test(ref)
  ) {
    throw new CliError("Task admission identity must be valid and pinned.", 64);
  }
  const commit = await reader.get(`repos/${repository}/git/commits/${ref}`);
  const tree = isJsonRecord(commit) ? commit.tree : undefined;
  const treeSha = isJsonRecord(tree) ? tree.sha : undefined;
  if (typeof treeSha !== "string" || !shaPattern.test(treeSha)) {
    throw new CliError("Task admission source tree identity is invalid.", 65);
  }
  const listing = await reader.get(`repos/${repository}/git/trees/${treeSha}?recursive=1`);
  if (!isJsonRecord(listing) || listing.truncated !== false || !Array.isArray(listing.tree)) {
    throw new CliError("Task admission source tree is incomplete.", 65);
  }

  const paths = new Map<string, string>([
    [`projects/${project}/.secrets.required`, "required"],
    [`projects/${project}/.secrets.allowed`, "allowed"],
  ]);
  const names = { required: [] as string[], allowed: [] as string[] };
  const discovered = new Set<string>();
  for (const entry of listing.tree) {
    if (!isJsonRecord(entry) || typeof entry.path !== "string" || !paths.has(entry.path)) {
      continue;
    }
    const kind = paths.get(entry.path);
    if (kind !== "required" && kind !== "allowed") {
      throw new CliError("Task admission declaration is invalid.", 65);
    }
    if (
      discovered.has(entry.path) ||
      entry.mode !== "100644" ||
      entry.type !== "blob" ||
      typeof entry.sha !== "string" ||
      !shaPattern.test(entry.sha)
    ) {
      throw new CliError("Task admission refuses unsafe secret declaration files.", 65);
    }
    discovered.add(entry.path);
    names[kind] = parseTaskSecretDeclaration(
      blobContent(await reader.get(`repos/${repository}/git/blobs/${entry.sha}`))
    );
  }

  const declared = [...names.required, ...names.allowed];
  if (new Set(declared).size !== declared.length) {
    throw new CliError("Task admission refuses overlapping required and allowed declarations.", 65);
  }
  const ceiling = await readTaskSecretCeiling(policyPath, repository, project, declared);
  if (declared.some((name) => !ceiling.has(name))) {
    throw new CliError("Task admission declares secrets outside the central policy.", 65);
  }
  const aliases = await readSecretAliases(policyPath, "task", repository, project);
  const aliasSources = new Set<string>();
  for (const name of declared) {
    const source = aliases.get(name) ?? name;
    if (!namePattern.test(source) || reserved(source) || aliasSources.has(source)) {
      throw new CliError("Task admission contains an invalid or overlapping credential alias.", 65);
    }
    aliasSources.add(source);
  }

  return {
    required_count: names.required.length,
    allowed_count: names.allowed.length,
    aliased_count: declared.filter((name) => aliases.has(name)).length,
    secret_values_read: false,
    repository_policy_modified: false,
  };
}

async function main(): Promise<void> {
  const repository = process.env.TASK_SOURCE_REPOSITORY ?? "";
  const project = process.env.PROJECT ?? "";
  const ref = process.env.BOOTSTRAP_REF?.toLowerCase() ?? "";
  const token = process.env.AW_CONTROL_TOKEN ?? "";
  if (!token) throw new CliError("Task admission requires a scoped source read token.", 77);
  const reader = new GithubReader(process.env.GITHUB_API_URL ?? "https://api.github.com", token);
  try {
    await validateTaskSecretAdmission(reader, repository, project, ref);
  } catch {
    // Task identifiers and declarations may be private. The public workflow log receives no details.
    throw new CliError(
      "Task secret admission failed; see the private policy and source manifests.",
      77
    );
  }
  console.log("Task secret admission: policy and pinned source declarations verified.");
}

if (isMain(import.meta.url)) main().catch(handleError);
