import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { parseDeployManifest } from "./deploy-manifest.ts";
import { parseRunnerPolicy, type RunnerPolicy, resolveRunnerProfile } from "./runner-policy.ts";
import { CliError, handleError, isMain } from "./runtime-command.ts";
import { parseReleaseBuildManifest } from "./validate-release-build-request.ts";

export type Consumer = { repository: string; path: string; runner_profile: string };
type GithubRepository = { full_name: string; default_branch: string };
type GithubTree = {
  truncated?: boolean;
  tree?: { path: string; type: string }[];
};
export type JsonGetter = (url: string) => Promise<unknown>;

const profilePath =
  /^(?:\.github|projects\/[A-Za-z0-9._-]+)\/(?:release\.manifest\.json|deploy\.json)$/;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CliError("GitHub repository metadata is invalid.", 65);
  }
  return value as Record<string, unknown>;
}

export function profilesFromManifest(
  repository: string,
  path: string,
  manifest: unknown
): Consumer[] {
  if (path.endsWith("/release.manifest.json")) {
    return parseReleaseBuildManifest(manifest).builds.map((build) => ({
      repository,
      path: `${path}#${build.id}`,
      runner_profile: build.runner_profile,
    }));
  }
  return [{ repository, path, runner_profile: parseDeployManifest(manifest).runner_profile }];
}

export function compatibilityRegressions(
  consumers: readonly Consumer[],
  baseline: RunnerPolicy,
  candidate: RunnerPolicy
): string[] {
  const findings: string[] = [];
  for (const consumer of consumers) {
    let before: ReturnType<typeof resolveRunnerProfile>;
    try {
      before = resolveRunnerProfile(baseline, consumer.runner_profile);
    } catch {
      // An already invalid downstream declaration is not caused by this candidate.
      continue;
    }
    let after: ReturnType<typeof resolveRunnerProfile>;
    try {
      after = resolveRunnerProfile(candidate, consumer.runner_profile);
    } catch (error) {
      findings.push(
        `${consumer.repository}/${consumer.path}: runner ${consumer.runner_profile} became unavailable: ${String(error)}`
      );
      continue;
    }
    const oldRunner = before.profile;
    const newRunner = after.profile;
    if (
      before.name !== after.name ||
      oldRunner.backend !== newRunner.backend ||
      oldRunner.trust_domain !== newRunner.trust_domain ||
      JSON.stringify(oldRunner.labels) !== JSON.stringify(newRunner.labels)
    ) {
      findings.push(
        `${consumer.repository}/${consumer.path}: runner ${consumer.runner_profile} changed from ${before.name} ${oldRunner.labels.join(",")} to ${after.name} ${newRunner.labels.join(",")}`
      );
    }
  }
  return findings;
}

async function requestGithubJson(url: string): Promise<unknown> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "fongap-labs-action-worker-compatibility",
  };
  if (process.env.GH_TOKEN) headers.Authorization = `Bearer ${process.env.GH_TOKEN}`;
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
  if (!response.ok) {
    throw new CliError(
      `Read-only downstream compatibility request failed (${response.status}): ${url}`,
      75
    );
  }
  return response.json() as Promise<unknown>;
}

export async function collectPublicConsumers(
  owner: string,
  getJson: JsonGetter
): Promise<Consumer[]> {
  if (!/^[A-Za-z0-9_.-]+$/.test(owner)) throw new CliError("Organization name is invalid.", 64);
  const result: Consumer[] = [];
  for (let page = 1; page <= 5; page++) {
    const reposRaw = await getJson(
      `https://api.github.com/orgs/${owner}/repos?type=public&per_page=100&page=${page}`
    );
    if (!Array.isArray(reposRaw)) throw new CliError("Repository listing is invalid.", 65);
    const repos = reposRaw as GithubRepository[];
    for (const item of repos) {
      const repo = record(item);
      if (
        typeof repo.full_name !== "string" ||
        !repo.full_name.startsWith(`${owner}/`) ||
        typeof repo.default_branch !== "string" ||
        !/^[A-Za-z0-9._/-]+$/.test(repo.default_branch)
      ) {
        throw new CliError("Repository listing contains invalid repository identity.", 65);
      }
      const tree = record(
        await getJson(
          `https://api.github.com/repos/${repo.full_name}/git/trees/${encodeURIComponent(repo.default_branch)}?recursive=1`
        )
      ) as GithubTree;
      if (tree.truncated || !Array.isArray(tree.tree)) {
        throw new CliError(`Cannot inspect complete repository tree: ${repo.full_name}`, 75);
      }
      for (const entry of tree.tree) {
        if (entry.type !== "blob" || !profilePath.test(entry.path)) continue;
        const contents = record(
          await getJson(
            `https://api.github.com/repos/${repo.full_name}/contents/${entry.path}?ref=${encodeURIComponent(repo.default_branch)}`
          )
        );
        if (contents.encoding !== "base64" || typeof contents.content !== "string") {
          throw new CliError(
            `Cannot read downstream manifest: ${repo.full_name}/${entry.path}`,
            65
          );
        }
        const manifest = JSON.parse(
          Buffer.from(contents.content.replace(/\s+/g, ""), "base64").toString("utf8")
        ) as unknown;
        result.push(...profilesFromManifest(repo.full_name, entry.path, manifest));
      }
    }
    if (repos.length < 100) return result;
  }
  throw new CliError(
    "Repository enumeration exceeded 500; review pagination before updating rules.",
    75
  );
}

async function main(): Promise<void> {
  const [baseSha] = process.argv.slice(2);
  if (!baseSha || !/^[0-9a-f]{40}$/.test(baseSha)) {
    throw new CliError("Usage: downstream-compatibility.ts <baseline-main-sha>", 64);
  }
  const baselineText = execFileSync("git", ["show", `${baseSha}:policies/runner.json`], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  const baseline = parseRunnerPolicy(JSON.parse(baselineText));
  const candidate = parseRunnerPolicy(JSON.parse(await readFile("policies/runner.json", "utf8")));
  const consumers = await collectPublicConsumers("fongap-labs", requestGithubJson);
  const findings = compatibilityRegressions(consumers, baseline, candidate);
  console.log(
    `Checked ${consumers.length} release/deploy declarations from public downstream repositories`
  );
  for (const finding of findings) console.error(`::error::${finding}`);
  if (findings.length > 0) {
    throw new CliError(
      `Downstream runner compatibility regressed in ${findings.length} locations.`,
      65
    );
  }
  console.log("No new downstream runner contract incompatibilities detected.");
}

if (isMain(import.meta.url)) main().catch(handleError);
