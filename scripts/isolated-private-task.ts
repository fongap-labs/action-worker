import { readFile } from "node:fs/promises";
import { GithubReader, isJsonRecord } from "./github-api.ts";
import { CliError, handleError, isMain } from "./runtime-command.ts";
import { validateTaskSecretAdmission } from "./validate-task-secret-admission.ts";

type Reader = Pick<GithubReader, "get">;
const pattern = /^[a-f0-9]{40}$/;
const capability = "stateful-private-v1\n";

function reject(): never {
  // All source identifiers remain private to the central workflow log.
  throw new CliError("Private isolated task pilot is not eligible; no legacy fallback.", 77);
}

export async function validatePrivateIsolationAdmission(
  reader: Reader,
  repository: string,
  project: string,
  sha: string,
  operation: string,
  policyPath = "policies/task-secrets.json"
): Promise<void> {
  if (
    !/^fongap-labs\/[A-Za-z0-9_.-]+$/.test(repository) ||
    !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(project) ||
    !pattern.test(sha) ||
    operation !== "task"
  ) reject();

  const metadata = await reader.get(`repos/${repository}`);
  if (!isJsonRecord(metadata) || metadata.private !== true) reject();

  // This opt-in is intentionally narrower than the normal task contract.
  // Business Secrets and Variables require a separately approved delivery design.
  const raw = JSON.parse(await readFile(policyPath, "utf8")) as unknown;
  const tasks = isJsonRecord(raw) ? raw.tasks : undefined;
  const projects = isJsonRecord(tasks) ? tasks[repository] : undefined;
  const entry = isJsonRecord(projects) ? projects[project] : undefined;
  if (
    !isJsonRecord(raw) ||
    raw.schema_version !== 1 ||
    !isJsonRecord(entry) ||
    !Array.isArray(entry.required) ||
    !Array.isArray(entry.allowed) ||
    entry.required.length !== 0 ||
    entry.allowed.length !== 0 ||
    (entry.aliases !== undefined &&
      (!isJsonRecord(entry.aliases) || Object.keys(entry.aliases).length !== 0))
  ) reject();

  const admission = await validateTaskSecretAdmission(reader, repository, project, sha, policyPath);
  if (admission.required_count !== 0 || admission.allowed_count !== 0) reject();

  const commit = await reader.get(`repos/${repository}/git/commits/${sha}`);
  const tree = isJsonRecord(commit) ? commit.tree : undefined;
  const treeSha = isJsonRecord(tree) ? tree.sha : undefined;
  if (typeof treeSha !== "string" || !pattern.test(treeSha)) reject();
  const listing = await reader.get(`repos/${repository}/git/trees/${treeSha}?recursive=1`);
  if (!isJsonRecord(listing) || listing.truncated !== false || !Array.isArray(listing.tree))
    reject();

  const markerPath = `projects/${project}/.isolated-private-task`;
  const found = listing.tree.filter(
    (item) => isJsonRecord(item) && item.path === markerPath
  );
  if (
    found.length !== 1 ||
    listing.tree.some(
      (item) =>
        isJsonRecord(item) &&
        (item.path === `projects/${project}/.vars.required` ||
          item.path === `projects/${project}/.vars.allowed`)
    )
  ) reject();
  const marker = found[0];
  if (
    !isJsonRecord(marker) ||
    marker.type !== "blob" ||
    marker.mode !== "100644" ||
    typeof marker.sha !== "string" ||
    !pattern.test(marker.sha)
  ) reject();
  const blob = await reader.get(`repos/${repository}/git/blobs/${marker.sha}`);
  if (
    !isJsonRecord(blob) ||
    blob.encoding !== "base64" ||
    typeof blob.content !== "string" ||
    blob.content.length > 128
  ) reject();
  const base64 = blob.content.replace(/\s/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) reject();
  const bytes = Buffer.from(base64, "base64");
  if (bytes.toString("base64") !== base64 || bytes.toString("utf8") !== capability) reject();
}

async function main(): Promise<void> {
  const token = process.env.AW_CONTROL_TOKEN ?? "";
  if (!token) reject();
  try {
    const reader = new GithubReader(process.env.GITHUB_API_URL ?? "https://api.github.com", token);
    await validatePrivateIsolationAdmission(
      reader,
      process.env.TASK_SOURCE_REPOSITORY ?? "",
      process.env.PROJECT ?? "",
      (process.env.BOOTSTRAP_REF ?? "").toLowerCase(),
      process.env.OPERATION ?? ""
    );
  } catch {
    reject();
  }
  console.log("Private isolated task eligibility verified; no production fallback.");
}

if (isMain(import.meta.url)) main().catch(handleError);
