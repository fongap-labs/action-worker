import { isJsonRecord } from "./github-api.ts";
import { resolveLinuxShards } from "./resolve-ci-capabilities.ts";
import { CliError, handleError, isMain } from "./runtime-command.ts";

const MAX_PAGES = 5;
const REPOSITORY = /^fongap-labs\/[A-Za-z0-9_.-]+$/;
const BRANCH = /^[A-Za-z0-9._/-]+$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const MANIFEST = ".github/execution-manifest.json";

export type ReadJson = (path: string, isOptional?: boolean) => Promise<unknown>;
export type ScanResult = {
  repositories: number;
  active: number;
  archived: number;
  manifests: number;
  incompatible: number;
};

function object(value: unknown): Record<string, unknown> {
  if (!isJsonRecord(value)) throw new CliError("CI compatibility inventory is malformed.", 65);
  return value;
}

function decodeManifest(value: unknown): unknown {
  const data = object(value);
  if (data.encoding !== "base64" || typeof data.content !== "string") {
    throw new CliError("CI compatibility manifest response is invalid.", 65);
  }
  const base64 = data.content.replace(/\s+/g, "");
  if (base64.length > 131072 || !BASE64.test(base64)) {
    throw new CliError("CI compatibility manifest encoding is invalid.", 65);
  }
  const decoded = Buffer.from(base64, "base64");
  if (decoded.toString("base64") !== base64) {
    throw new CliError("CI compatibility manifest is not canonical base64.", 65);
  }
  return JSON.parse(decoded.toString("utf8")) as unknown;
}

/**
 * Check currently authorized public/private repositories before changing
 * the central dispatcher contract. Archived repositories are counted but
 * excluded from merge admission until reactivated. Never print private
 * repository identities or manifest contents.
 */
export async function scanInstalledCiContracts(readJson: ReadJson): Promise<ScanResult> {
  const result: ScanResult = {
    repositories: 0,
    active: 0,
    archived: 0,
    manifests: 0,
    incompatible: 0,
  };
  const seen = new Set<string>();
  let expectedTotal: number | null = null;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const response = object(await readJson("installation/repositories?per_page=100&page=" + page));
    if (!Array.isArray(response.repositories) || !Number.isSafeInteger(response.total_count)) {
      throw new CliError("CI compatibility inventory pagination is invalid.", 65);
    }
    const total = Number(response.total_count);
    if (total < 0 || (expectedTotal !== null && total !== expectedTotal)) {
      throw new CliError("CI compatibility inventory changed during scan.", 75);
    }
    expectedTotal = total;
    const entries = response.repositories as unknown[];
    if (entries.length > 100) {
      throw new CliError("CI compatibility inventory page is too large.", 65);
    }
    for (const item of entries) {
      const entry = object(item);
      if (
        typeof entry.full_name !== "string" ||
        !REPOSITORY.test(entry.full_name) ||
        typeof entry.default_branch !== "string" ||
        !BRANCH.test(entry.default_branch) ||
        entry.default_branch.includes("..") ||
        typeof entry.private !== "boolean" ||
        typeof entry.archived !== "boolean" ||
        seen.has(entry.full_name)
      ) {
        throw new CliError("CI compatibility repository metadata is invalid.", 65);
      }
      seen.add(entry.full_name);
      result.repositories++;
      if (entry.archived) {
        result.archived++;
        continue;
      }
      result.active++;
      const path =
        "repos/" +
        entry.full_name +
        "/contents/" +
        MANIFEST +
        "?ref=" +
        encodeURIComponent(entry.default_branch);
      const response = await readJson(path, true);
      if (response === null) continue;
      result.manifests++;
      try {
        resolveLinuxShards(decodeManifest(response));
      } catch {
        result.incompatible++;
      }
    }
    if (seen.size === total) return result;
    if (entries.length < 100) {
      throw new CliError("CI compatibility inventory is incomplete.", 75);
    }
  }
  throw new CliError("CI compatibility inventory exceeded pagination budget.", 75);
}

async function githubRead(path: string, isOptional = false): Promise<unknown> {
  const token = process.env.AW_CI_COMPAT_READ_TOKEN ?? "";
  if (!token) throw new CliError("CI compatibility read token is missing.", 77);
  const response = await fetch("https://api.github.com/" + path, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: "Bearer " + token,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "fongap-labs-ci-compatibility",
    },
    signal: AbortSignal.timeout(15000),
  });
  if (isOptional && response.status === 404) return null;
  if (!response.ok) {
    throw new CliError("CI compatibility inventory read failed.", 75);
  }
  return response.json() as Promise<unknown>;
}

async function main(): Promise<void> {
  let scan: ScanResult;
  try {
    scan = await scanInstalledCiContracts(githubRead);
  } catch {
    throw new CliError("CI compatibility inventory unavailable; fail closed.", 75);
  }
  console.log(
    "CI compatibility inventory: " +
      scan.repositories +
      " authorized, " +
      scan.active +
      " active, " +
      scan.archived +
      " archived, " +
      scan.manifests +
      " manifests, " +
      scan.incompatible +
      " incompatible; identities withheld."
  );
  if (scan.incompatible > 0) {
    throw new CliError("Downstream CI manifests require migration; merge refused.", 75);
  }
}

if (isMain(import.meta.url)) main().catch(handleError);
