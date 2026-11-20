import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ChangedFile,
  inspectEngineeringOwnership,
  parseOwnershipPolicy,
  type OwnershipPolicy,
} from "./central-engineering-gate.ts";
import { decodeGithubContent, getGithubJson, isJsonRecord } from "./github-api.ts";
import { CliError, handleError, isMain } from "./runtime-command.ts";

const SHA = /^[a-f0-9]{40}$/;
const REPOSITORY = /^fongap-labs\/[A-Za-z0-9_.-]+$/;

export function parseCompareFiles(response: unknown): ChangedFile[] {
  if (!isJsonRecord(response) || !Array.isArray(response.files)) {
    throw new CliError("GitHub comparison did not return a file inventory.", 65);
  }
  // GitHub Compare exposes at most 300 files. Never call that a complete inventory.
  if (response.files.length >= 300) {
    throw new CliError("GitHub comparison exceeds the central engineering gate file limit.", 65);
  }
  const mapped: ChangedFile[] = [];
  for (const entry of response.files) {
    if (!isJsonRecord(entry) || typeof entry.filename !== "string") {
      throw new CliError("GitHub comparison file inventory is malformed.", 65);
    }
    if (entry.status === "removed") continue;
    const status =
      entry.status === "added" || entry.status === "renamed" || entry.status === "copied"
        ? "A"
        : entry.status === "modified"
          ? "M"
          : entry.status === "changed"
            ? "T"
            : null;
    if (status === null) {
      throw new CliError("GitHub comparison contains an unsupported change status.", 65);
    }
    mapped.push({ status, path: entry.filename });
  }
  return mapped;
}

export async function checkGithubEngineeringOwnership(
  repository: string,
  base: string,
  head: string,
  policy: OwnershipPolicy,
  get: (path: string) => Promise<unknown>,
  readTrustedTemplate: (path: string) => string
): Promise<void> {
  if (!REPOSITORY.test(repository) || !SHA.test(base) || !SHA.test(head)) {
    throw new CliError("Invalid immutable engineering gate inputs.", 65);
  }
  if (repository === policy.control_repository) return;
  const result = await get("repos/" + repository + "/compare/" + base + "..." + head);
  if (!isJsonRecord(result) || !isJsonRecord(result.base_commit) ||
      !isJsonRecord(result.head_commit) ||
      result.base_commit.sha !== base || result.head_commit.sha !== head) {
    throw new CliError("GitHub comparison does not match the immutable CI revision.", 65);
  }
  const files = parseCompareFiles(result);
  const contents = new Map<string, string>();
  for (const entry of files) {
    if (!entry.path.startsWith(".github/workflows/")) continue;
    if (!policy.workflow_templates[entry.path]) continue;
    const data = await get(
      "repos/" + repository + "/contents/" +
        entry.path.split("/").map(encodeURIComponent).join("/") + "?ref=" + head
    );
    contents.set(entry.path, decodeGithubContent(data));
  }
  const findings = inspectEngineeringOwnership(
    policy,
    repository,
    files,
    (path) => {
      const content = contents.get(path);
      if (content === undefined) throw new CliError("Missing workflow contents in verified compare.", 65);
      return content;
    },
    readTrustedTemplate
  );
  if (findings.length > 0) {
    const detail =
      process.env.TARGET_PRIVATE === "true"
        ? "Details withheld for private repository."
        : findings.map((item) => item.code + ": " + item.path).join("; ");
    throw new CliError(
      "Central engineering ownership gate denied " + findings.length + " change(s). " + detail,
      65
    );
  }
  console.log("Central engineering ownership gate passed (" + files.length + " files).");
}

async function main(): Promise<void> {
  const [repository = "", base = "", head = ""] = process.argv.slice(2);
  const controlRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const policy = parseOwnershipPolicy(
    JSON.parse(readFileSync(join(controlRoot, "policies", "engineering-ownership.json"), "utf8")) as unknown
  );
  const token = process.env.AW_CONTROL_TOKEN ?? "";
  if (!token) throw new CliError("Central engineering ownership gate read token is missing.", 77);
  try {
    await checkGithubEngineeringOwnership(
      repository,
      base,
      head,
      policy,
      (path) => getGithubJson(path, token),
      (path) => readFileSync(join(controlRoot, path), "utf8")
    );
  } catch (error) {
    if (process.env.TARGET_PRIVATE === "true") {
      throw new CliError("Central engineering ownership gate failed; details withheld for private repository.", 65);
    }
    throw error;
  }
}

if (isMain(import.meta.url)) main().catch(handleError);
