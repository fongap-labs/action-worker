import {
  GithubReader,
  getJsonArray,
  getJsonString,
  githubEnvironment,
  isJsonRecord,
} from "./github-api.ts";
import {
  CliError,
  appendLines,
  handleError,
  isMain,
  readJson,
  runText,
} from "./runtime-command.ts";

type DeployPolicyEntry = {
  automatic: boolean;
  event_type: string;
  ignore_docs_only: boolean;
};

type DeployPolicy = {
  schema_version: 1;
  repositories: Record<string, DeployPolicyEntry>;
};

const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const eventPattern = /^[A-Za-z0-9._:-]{1,100}$/;
const shaPattern = /^[0-9a-f]{40}$/;

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((item, index) => item === expected[index]);
}

export function parseDeployPolicy(value: unknown): DeployPolicy {
  if (!isJsonRecord(value)
    || value.schema_version !== 1
    || !isJsonRecord(value.repositories)
  ) {
    throw new CliError("Deploy policy is invalid.", 65);
  }

  for (const [repository, raw] of Object.entries(value.repositories)) {
    if (!repositoryPattern.test(repository)
      || !isJsonRecord(raw)
      || !exactKeys(raw, ["automatic", "event_type", "ignore_docs_only"])
      || typeof raw.automatic !== "boolean"
      || typeof raw.event_type !== "string" || !eventPattern.test(raw.event_type)
      || typeof raw.ignore_docs_only !== "boolean"
    ) {
      throw new CliError(`Deploy policy entry is invalid: ${repository}.`, 65);
    }
  }

  return value as DeployPolicy;
}

export function isDocsOnly(paths: readonly string[]): boolean {
  return paths.length > 0 && paths.every((path) => (
    path.endsWith(".md")
    || path.startsWith("docs/")
  ));
}

async function main(): Promise<void> {
  const [repository = "", headSha = "", prNumberRaw = "", policyPath = "policies/deploy.json"] = process.argv.slice(2);
  if (!repositoryPattern.test(repository)
    || !shaPattern.test(headSha)
    || !/^\d+$/.test(prNumberRaw)
  ) {
    throw new CliError(
      "Usage: dispatch-central-deploy.ts <repository> <head-sha> <pr-number> [policy-file]",
      64,
    );
  }

  if (prNumberRaw !== "0") {
    console.log(`Automatic deploy skipped for pull request CI: ${repository}#${prNumberRaw}`);
    return;
  }

  const policy = parseDeployPolicy(await readJson(policyPath));
  const entry = policy.repositories[repository];
  if (!entry?.automatic) {
    console.log(`Automatic deploy is disabled by policy: ${repository}`);
    return;
  }

  const controlToken = process.env.AW_CONTROL_TOKEN ?? "";
  const dispatchToken = process.env.GH_TOKEN ?? "";
  const controlRepository = process.env.GITHUB_REPOSITORY ?? "";
  if (!controlToken || !dispatchToken || !repositoryPattern.test(controlRepository)) {
    throw new CliError("Central deploy runtime credentials are unavailable.", 77);
  }

  const reader = new GithubReader(process.env.GITHUB_API_URL ?? "https://api.github.com", controlToken);
  const repositoryJson = await reader.get(`repos/${repository}`);
  const defaultBranch = getJsonString(repositoryJson, "default_branch");
  const defaultCommit = await reader.get(`repos/${repository}/commits/${defaultBranch}`);
  const defaultSha = getJsonString(defaultCommit, "sha");
  if (defaultSha !== headSha) {
    throw new CliError(
      `Automatic deploy source is stale: expected=${defaultSha} actual=${headSha}.`,
      75,
    );
  }

  const commit = await reader.get(`repos/${repository}/commits/${headSha}`);
  const changedFiles = getJsonArray(commit, "files")
    .filter(isJsonRecord)
    .map((item) => getJsonString(item, "filename"))
    .filter(Boolean);

  if (entry.ignore_docs_only && isDocsOnly(changedFiles)) {
    console.log(`Automatic deploy skipped for documentation-only commit: ${repository}@${headSha}`);
    await appendLines(process.env.GITHUB_STEP_SUMMARY, [
      "## Central deploy dispatch",
      "",
      `- Repository: ${repository}`,
      `- Commit: ${headSha}`,
      "- Result: skipped (documentation-only)",
    ]);
    return;
  }

  const requestId = [
    "deploy",
    process.env.GITHUB_RUN_ID ?? "0",
    process.env.GITHUB_RUN_ATTEMPT ?? "1",
    headSha.slice(0, 12),
  ].join("-");
  const payload = JSON.stringify({
    event_type: entry.event_type,
    client_payload: {
      schema_version: "1",
      request_id: requestId,
      source_repository: repository,
      source_sha: headSha,
    },
  });

  await runText(
    "gh",
    [
      "api",
      "--method",
      "POST",
      `repos/${controlRepository}/dispatches`,
      "--input",
      "-",
    ],
    {
      env: githubEnvironment(dispatchToken),
      input: payload,
    },
  );

  await appendLines(process.env.GITHUB_STEP_SUMMARY, [
    "## Central deploy dispatch",
    "",
    `- Repository: ${repository}`,
    `- Commit: ${headSha}`,
    `- Event: ${entry.event_type}`,
    "- Result: dispatched",
  ]);
  console.log(`Central deploy dispatched: ${repository}@${headSha} -> ${entry.event_type}`);
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
