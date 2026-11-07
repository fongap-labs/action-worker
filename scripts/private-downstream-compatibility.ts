import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  type Consumer,
  type JsonGetter,
  profilesFromManifest,
} from "./downstream-compatibility.ts";
import { parseRunnerPolicy, type RunnerPolicy, resolveRunnerProfile } from "./runner-policy.ts";
import { CliError, handleError, isMain } from "./runtime-command.ts";

const manifestPattern =
  /^(?:\.github|projects\/[A-Za-z0-9._-]+)\/(?:release\.manifest\.json|deploy\.json)$/;
const repositoryPattern = /^fongap-labs\/[A-Za-z0-9_.-]+$/;

type InventoryItem = {
  full_name: string;
  default_branch: string;
  private: boolean;
  archived?: boolean;
};
type PrivateScan = { repositories: number; consumers: Consumer[] };

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CliError("Private inventory response is malformed.", 65);
  }
  return value as Record<string, unknown>;
}

function privateFingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

export async function collectPrivateConsumers(getJson: JsonGetter): Promise<PrivateScan> {
  const consumers: Consumer[] = [];
  let repositories = 0;
  for (let page = 1; page <= 5; page++) {
    const response = object(
      await getJson(`https://api.github.com/installation/repositories?per_page=100&page=${page}`)
    );
    if (!Array.isArray(response.repositories)) {
      throw new CliError("Private inventory repository list is invalid.", 65);
    }
    const items = response.repositories as InventoryItem[];
    for (const item of items) {
      const metadata = object(item);
      if (metadata.private !== true || metadata.archived === true) continue;
      if (
        typeof metadata.full_name !== "string" ||
        !repositoryPattern.test(metadata.full_name) ||
        typeof metadata.default_branch !== "string" ||
        !/^[A-Za-z0-9._/-]+$/.test(metadata.default_branch)
      ) {
        throw new CliError("Private repository metadata is invalid.", 65);
      }
      repositories++;
      const identity = metadata.full_name;
      const branch = encodeURIComponent(metadata.default_branch);
      const listing = object(
        await getJson(`https://api.github.com/repos/${identity}/git/trees/${branch}?recursive=1`)
      );
      if (listing.truncated !== false || !Array.isArray(listing.tree)) {
        throw new CliError("Private repository tree is truncated or unavailable.", 75);
      }
      for (const entry of listing.tree) {
        const source = object(entry);
        if (source.type !== "blob" || typeof source.path !== "string") continue;
        if (!manifestPattern.test(source.path)) continue;
        const contents = object(
          await getJson(
            `https://api.github.com/repos/${identity}/contents/${source.path}?ref=${branch}`
          )
        );
        if (contents.encoding !== "base64" || typeof contents.content !== "string") {
          throw new CliError("Private manifest contents are invalid.", 65);
        }
        const raw = contents.content.replace(/\s+/g, "");
        if (
          raw.length > 131072 ||
          !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(raw)
        ) {
          throw new CliError("Private manifest encoding is invalid or oversized.", 65);
        }
        const bytes = Buffer.from(raw, "base64");
        if (bytes.toString("base64") !== raw) {
          throw new CliError("Private manifest base64 encoding is invalid.", 65);
        }
        const decoded = JSON.parse(bytes.toString("utf8")) as unknown;
        consumers.push(...profilesFromManifest(identity, source.path, decoded));
      }
    }
    if (items.length < 100) return { repositories, consumers };
  }
  throw new CliError("Private repository inventory pagination exceeded limit.", 75);
}

export function privateCompatibilityFailures(
  scan: PrivateScan,
  runnerPolicy: RunnerPolicy
): string[] {
  const failures: string[] = [];
  for (const consumer of scan.consumers) {
    try {
      const runner = resolveRunnerProfile(runnerPolicy, consumer.runner_profile);
      const expected = consumer.path.includes("release.manifest.json") ? "sandbox" : "privileged";
      if (runner.profile.trust_domain !== expected) {
        throw new CliError("Runner has the wrong trust domain.", 65);
      }
    } catch {
      failures.push(privateFingerprint(`${consumer.repository}/${consumer.path}`));
    }
  }
  return failures;
}

async function getJson(url: string): Promise<unknown> {
  const token = process.env.GH_TOKEN;
  if (!token) throw new CliError("Read-only private inventory token is missing.", 77);
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "fongap-labs-private-compatibility",
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    throw new CliError("Read-only private inventory request failed.", 75);
  }
  return response.json() as Promise<unknown>;
}

async function main(): Promise<void> {
  let scan: PrivateScan;
  try {
    scan = await collectPrivateConsumers(getJson);
  } catch {
    // Action Worker is public: never expose private repo names or manifest content to logs.
    throw new CliError("Private compatibility inventory failed; repository details withheld.", 75);
  }
  const policy = parseRunnerPolicy(JSON.parse(await readFile("policies/runner.json", "utf8")));
  const failures = privateCompatibilityFailures(scan, policy);
  console.log(
    `Private compatibility checked: ${scan.repositories} repositories, ${scan.consumers.length} declarations; no paths disclosed.`
  );
  if (failures.length > 0) {
    console.error(
      `Private compatibility failures (anonymous fingerprints): ${failures.join(", ")}`
    );
    throw new CliError("One or more private manifest Runner contracts are invalid.", 65);
  }
}

if (isMain(import.meta.url)) main().catch(handleError);
