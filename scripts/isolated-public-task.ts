import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GithubReader, isJsonRecord } from "./github-api.ts";
import { CliError, handleError, isMain } from "./runtime-command.ts";
import {
  legacyTaskStateArtifactName,
  taskStateArtifactName,
  writeTaskStateManifest,
} from "./task-state.ts";
import { packTaskTransferFiles, unpackTaskTransferFiles } from "./task-transfer-files.ts";
import { validateTaskSecretAdmission } from "./validate-task-secret-admission.ts";

const shaPattern = /^[a-f0-9]{40}$/;
const capability = "stateless-public-v1";
const controlRepository = "fongap-labs/action-worker";
type Reader = Pick<GithubReader, "get">;

function identity(repository: string, project: string, sha: string): void {
  if (
    !/^fongap-labs\/[A-Za-z0-9_.-]+$/.test(repository) ||
    !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(project) ||
    !shaPattern.test(sha)
  ) {
    throw new CliError("Isolated task identity is invalid.", 64);
  }
}

function fail(): never {
  throw new CliError("Isolated task pilot is not eligible; no legacy fallback.", 77);
}

export async function validateIsolatedPublicTask(
  reader: Reader,
  repository: string,
  project: string,
  sha: string,
  operation: string,
  policyPath = "policies/task-secrets.json"
): Promise<void> {
  identity(repository, project, sha);
  if (operation !== "task") fail();
  const metadata = await reader.get(`repos/${repository}`);
  if (!isJsonRecord(metadata) || metadata.private !== false) fail();

  const policy: unknown = JSON.parse(await readFile(policyPath, "utf8"));
  const repos = isJsonRecord(policy) ? policy.tasks : undefined;
  const projects = isJsonRecord(repos) ? repos[repository] : undefined;
  const policyEntry = isJsonRecord(projects) ? projects[project] : undefined;
  if (
    !isJsonRecord(policy) ||
    policy.schema_version !== 1 ||
    !isJsonRecord(policyEntry) ||
    !Array.isArray(policyEntry.required) ||
    !Array.isArray(policyEntry.allowed) ||
    policyEntry.required.length !== 0 ||
    policyEntry.allowed.length !== 0 ||
    (isJsonRecord(policyEntry.aliases) && Object.keys(policyEntry.aliases).length !== 0) ||
    (policyEntry.aliases !== undefined && !isJsonRecord(policyEntry.aliases))
  )
    fail();

  const admission = await validateTaskSecretAdmission(reader, repository, project, sha, policyPath);
  if (admission.required_count !== 0 || admission.allowed_count !== 0) fail();

  const commit = await reader.get(`repos/${repository}/git/commits/${sha}`);
  const tree = isJsonRecord(commit) ? commit.tree : undefined;
  const treeSha = isJsonRecord(tree) ? tree.sha : undefined;
  if (typeof treeSha !== "string" || !shaPattern.test(treeSha)) fail();
  const listing = await reader.get(`repos/${repository}/git/trees/${treeSha}?recursive=1`);
  if (!isJsonRecord(listing) || listing.truncated !== false || !Array.isArray(listing.tree)) fail();
  const markerPath = `projects/${project}/.isolated-task`;
  // A pilot must not ingest project Variables; this mode does not yet have
  // a reviewed configuration classification or environment-scoped grant.
  if (
    listing.tree.some(
      (entry) =>
        isJsonRecord(entry) &&
        typeof entry.path === "string" &&
        [`projects/${project}/.vars.required`, `projects/${project}/.vars.allowed`].includes(
          entry.path
        )
    )
  )
    fail();
  const entries = listing.tree.filter((entry) => isJsonRecord(entry) && entry.path === markerPath);
  if (entries.length !== 1) fail();
  const marker = entries[0];
  if (
    !isJsonRecord(marker) ||
    marker.type !== "blob" ||
    marker.mode !== "100644" ||
    typeof marker.sha !== "string" ||
    !shaPattern.test(marker.sha)
  )
    fail();
  const blob = await reader.get(`repos/${repository}/git/blobs/${marker.sha}`);
  if (
    !isJsonRecord(blob) ||
    blob.encoding !== "base64" ||
    typeof blob.content !== "string" ||
    blob.content.length > 128
  )
    fail();
  const raw = blob.content.replace(/\s/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(raw)) fail();
  const data = Buffer.from(raw, "base64");
  if (data.toString("base64") !== raw || data.toString("utf8") !== `${capability}\n`) fail();
}

export async function prepareIsolatedPublicState(
  reader: Reader,
  repository: string,
  project: string,
  sha: string
): Promise<Buffer> {
  identity(repository, project, sha);
  // Refuse any prior artifact, including failed, expired or unverified runs.
  // Never interpret a truncated success-only history as an empty state.
  for (const name of [
    taskStateArtifactName(repository, project),
    legacyTaskStateArtifactName(repository, project),
  ]) {
    const listing = await reader.get(
      `repos/${controlRepository}/actions/artifacts?name=${encodeURIComponent(name)}&per_page=1`
    );
    if (
      !isJsonRecord(listing) ||
      !Number.isSafeInteger(listing.total_count) ||
      (listing.total_count as number) !== 0 ||
      !Array.isArray(listing.artifacts) ||
      listing.artifacts.length !== 0
    )
      fail();
  }
  const root = await mkdtemp(join(tmpdir(), "aw-isolated-public-"));
  try {
    await writeTaskStateManifest(root, repository, project, sha);
    return await packTaskTransferFiles(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export async function finalizeIsolatedPublicState(
  packed: Buffer,
  output: string,
  repository: string,
  project: string,
  sha: string
): Promise<void> {
  identity(repository, project, sha);
  // Validate the complete untrusted payload before any trusted output is created.
  await unpackTaskTransferFiles(packed, output);
  let manifest: unknown;
  try {
    manifest = JSON.parse(await readFile(join(output, "manifest.json"), "utf8")) as unknown;
  } catch {
    throw new CliError("Isolated task result manifest is invalid.", 66);
  }
  if (
    !isJsonRecord(manifest) ||
    Object.keys(manifest).sort().join(",") !== "bootstrap_ref,project,repository" ||
    manifest.repository !== repository ||
    manifest.project !== project ||
    manifest.bootstrap_ref !== sha
  ) {
    throw new CliError("Isolated task result identity does not match.", 66);
  }
}

async function main(): Promise<void> {
  const [command = "", arg = "", destination = ""] = process.argv.slice(2);
  const repository = process.env.TASK_SOURCE_REPOSITORY ?? "";
  const project = process.env.PROJECT ?? "";
  const sha = (process.env.BOOTSTRAP_REF ?? "").toLowerCase();
  const token = process.env.AW_CONTROL_TOKEN ?? process.env.GH_TOKEN ?? "";
  const reader = new GithubReader(process.env.GITHUB_API_URL ?? "https://api.github.com", token);
  try {
    if (command === "admit") {
      if (!token) fail();
      await validateIsolatedPublicTask(
        reader,
        repository,
        project,
        sha,
        process.env.OPERATION ?? ""
      );
    } else if (command === "prepare" && arg && token) {
      const result = await prepareIsolatedPublicState(reader, repository, project, sha);
      await writeFile(arg, result, { flag: "wx", mode: 0o600 });
    } else if (command === "open-input" && arg && destination) {
      identity(repository, project, sha);
      await unpackTaskTransferFiles(await readFile(arg), destination);
    } else if (command === "finalize" && arg && destination) {
      await finalizeIsolatedPublicState(await readFile(arg), destination, repository, project, sha);
    } else {
      throw new CliError("Isolated public task command is invalid.", 64);
    }
  } catch {
    // Never put task source details from protected admission in a public log.
    throw new CliError("Isolated task pilot refused or failed verification.", 77);
  }
  console.log("Isolated public task phase verified.");
}

if (isMain(import.meta.url)) main().catch(handleError);
