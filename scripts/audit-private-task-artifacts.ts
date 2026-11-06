import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { GithubReader, getJsonArray, getJsonNumber, getJsonString, isJsonRecord } from "./github-api.ts";
import { CliError, handleError, isMain } from "./runtime-command.ts";
import { taskStateArtifactName } from "./task-state.ts";

type Reader = { get(path: string): Promise<unknown> };
type Candidate = { repository: string; project: string };
type Artifact = {
  id: number;
  run: number;
  expired: boolean;
};
type Check = {
  alias: string;
  artifact_count: number;
  trusted_artifact_count: number;
  untrusted_artifact_count: number;
  expired_artifact_count: number;
  trusted_run_ids: number[];
  artifact_listing_complete: boolean;
};

const workflowPath = ".github/workflows/handle-task-dispatch.yml";
const maxPages = 3;

function requiredRecord(value: unknown): Record<string, unknown> {
  if (!isJsonRecord(value)) throw new CliError("Invalid audit policy or GitHub response.", 65);
  return value;
}

export function inventoryCandidates(policy: unknown): Candidate[] {
  const root = requiredRecord(policy);
  const tasks = requiredRecord(root.tasks);
  const candidates: Candidate[] = [];
  for (const [repository, projects] of Object.entries(tasks)) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
      throw new CliError("Invalid task policy repository.", 65);
    }
    const entries = requiredRecord(projects);
    for (const project of Object.keys(entries)) {
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(project)) {
        throw new CliError("Invalid task policy project.", 65);
      }
      candidates.push({ repository, project });
    }
  }
  return candidates.sort((a, b) =>
    `${a.repository}\0${a.project}`.localeCompare(`${b.repository}\0${b.project}`)
  );
}

function alias(candidate: Candidate): string {
  return createHash("sha256")
    .update(`${candidate.repository}\0${candidate.project}`)
    .digest("hex")
    .slice(0, 16);
}

async function listArtifacts(
  reader: Reader,
  controlRepository: string,
  name: string
): Promise<{ artifacts: Artifact[]; complete: boolean }> {
  const artifacts: Artifact[] = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const raw = requiredRecord(
      await reader.get(
        `repos/${controlRepository}/actions/artifacts?name=${encodeURIComponent(name)}&per_page=100&page=${page}`
      )
    );
    const list = getJsonArray(raw, "artifacts");
    for (const value of list) {
      const artifact = requiredRecord(value);
      if (getJsonString(artifact, "name") !== name) {
        throw new CliError("Unexpected artifact identity in audit listing.", 65);
      }
      const id = getJsonNumber(artifact, "id");
      const run = getJsonNumber(artifact.workflow_run, "id");
      if (!Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(run) || run <= 0) {
        throw new CliError("Artifact is missing a valid identity or run ID.", 65);
      }
      artifacts.push({ id, run, expired: artifact.expired === true });
    }
    if (list.length < 100) return { artifacts, complete: true };
  }
  return { artifacts, complete: false };
}

export async function auditTaskArtifacts(
  reader: Reader,
  controlRepository: string,
  candidates: Candidate[]
): Promise<{ status: "INCOMPLETE"; scope: string; candidates: Check[] }> {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(controlRepository)) {
    throw new CliError("Invalid control repository.", 64);
  }
  const runCache = new Map<number, boolean>();
  const checks: Check[] = [];
  for (const candidate of candidates) {
    const name = taskStateArtifactName(candidate.repository, candidate.project);
    const listing = await listArtifacts(reader, controlRepository, name);
    let trusted = 0;
    let untrusted = 0;
    let expired = 0;
    const trustedRuns = new Set<number>();
    for (const artifact of listing.artifacts) {
      if (artifact.expired) {
        expired += 1;
        continue;
      }
      if (!runCache.has(artifact.run)) {
        const run = requiredRecord(
          await reader.get(`repos/${controlRepository}/actions/runs/${artifact.run}`)
        );
        runCache.set(
          artifact.run,
          getJsonString(run, "path") === workflowPath &&
            getJsonString(run, "head_branch") === "main" &&
            getJsonString(run, "conclusion") === "success"
        );
      }
      if (runCache.get(artifact.run) === true) {
        trusted += 1;
        trustedRuns.add(artifact.run);
      } else {
        untrusted += 1;
      }
    }
    checks.push({
      alias: alias(candidate),
      artifact_count: listing.artifacts.length,
      trusted_artifact_count: trusted,
      untrusted_artifact_count: untrusted,
      expired_artifact_count: expired,
      trusted_run_ids: [...trustedRuns].sort((a, b) => b - a),
      artifact_listing_complete: listing.complete,
    });
  }
  // This tool cannot prove dispatch payloads, external writers, or successful decryption.
  return { status: "INCOMPLETE", scope: "artifact-metadata-only", candidates: checks };
}

async function main(): Promise<void> {
  const token = process.env.GH_TOKEN ?? "";
  if (!token) throw new CliError("A read-only GH_TOKEN is required.", 77);
  const policy = JSON.parse(await readFile("policies/task-secrets.json", "utf8")) as unknown;
  const candidates = inventoryCandidates(policy);
  const controlRepository = process.env.GITHUB_REPOSITORY ?? "fongap-labs/action-worker";
  const reader = new GithubReader(process.env.GITHUB_API_URL ?? "https://api.github.com", token);
  const output = await auditTaskArtifacts(reader, controlRepository, candidates);
  console.log(JSON.stringify(output, null, 2));
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
