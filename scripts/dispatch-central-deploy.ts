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
  parseJson,
  readJson,
  runText,
} from "./runtime-command.ts";
import {
  type DeployAdapter,
  resolveDeployManifest,
} from "./deploy-manifest.ts";

type DeployAdapterPolicy = {
  event_type: string;
};

type DeployPolicy = {
  schema_version: 2;
  adapters: Record<string, DeployAdapterPolicy>;
};

const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const adapterPattern = /^[a-z][a-z0-9-]{0,63}$/;
const eventPattern = /^[A-Za-z0-9._:-]{1,100}$/;
const shaPattern = /^[0-9a-f]{40}$/;

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((item, index) => item === expected[index]);
}

export function parseDeployPolicy(value: unknown): DeployPolicy {
  if (!isJsonRecord(value)
    || !exactKeys(value, ["adapters", "schema_version"])
    || value.schema_version !== 2
    || !isJsonRecord(value.adapters)
  ) {
    throw new CliError("Deploy adapter policy is invalid.", 65);
  }

  for (const [adapter, raw] of Object.entries(value.adapters)) {
    if (!adapterPattern.test(adapter)
      || !isJsonRecord(raw)
      || !exactKeys(raw, ["event_type"])
      || typeof raw.event_type !== "string"
      || !eventPattern.test(raw.event_type)
    ) {
      throw new CliError(`Deploy adapter policy entry is invalid: ${adapter}.`, 65);
    }
  }

  return value as DeployPolicy;
}

export function deployEventType(policy: DeployPolicy, adapter: DeployAdapter): string {
  const entry = policy.adapters[adapter];
  if (!entry) {
    throw new CliError(`Deploy adapter has no registered executor: ${adapter}.`, 65);
  }
  return entry.event_type;
}

export function isDocsOnly(paths: readonly string[]): boolean {
  return paths.length > 0 && paths.every((path) => (
    path.endsWith(".md")
    || path.startsWith("docs/")
  ));
}

async function main(): Promise<void> {
  const [
    repository = "",
    headSha = "",
    prNumberRaw = "",
    policyPath = "policies/deploy.json",
    runnerPolicyPath = "policies/runner.json",
  ] = process.argv.slice(2);

  if (!repositoryPattern.test(repository)
    || !shaPattern.test(headSha)
    || !/^\d+$/.test(prNumberRaw)
  ) {
    throw new CliError(
      "Usage: dispatch-central-deploy.ts <repository> <head-sha> <pr-number> [adapter-policy] [runner-policy]",
      64,
    );
  }

  if (prNumberRaw !== "0") {
    console.log(`Automatic deploy skipped for pull request CI: ${repository}#${prNumberRaw}`);
    return;
  }

  const controlToken = process.env.AW_CONTROL_TOKEN ?? "";
  const dispatchToken = process.env.GH_TOKEN ?? "";
  const controlRepository = process.env.GITHUB_REPOSITORY ?? "";
  const rawRepositoryPolicy = process.env.AW_REPOSITORY_POLICY ?? "";
  if (!controlToken
    || !dispatchToken
    || !rawRepositoryPolicy
    || !repositoryPattern.test(controlRepository)
  ) {
    throw new CliError("Central deploy runtime credentials or repository policy are unavailable.", 77);
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

  const manifest = await resolveDeployManifest(
    repository,
    headSha,
    parseJson(rawRepositoryPolicy, "AW_REPOSITORY_POLICY must be valid JSON.", 65),
    await readJson(runnerPolicyPath),
    reader,
  );
  if (!manifest.automatic) {
    console.log(`Automatic deploy is disabled by source manifest: ${repository}`);
    return;
  }

  const commit = await reader.get(`repos/${repository}/commits/${headSha}`);
  const changedFiles = getJsonArray(commit, "files")
    .filter(isJsonRecord)
    .map((item) => getJsonString(item, "filename"))
    .filter(Boolean);

  if (manifest.ignore_docs_only && isDocsOnly(changedFiles)) {
    console.log(`Automatic deploy skipped for documentation-only commit: ${repository}@${headSha}`);
    await appendLines(process.env.GITHUB_STEP_SUMMARY, [
      "## Central deploy dispatch",
      "",
      `- Repository: ${repository}`,
      `- Commit: ${headSha}`,
      `- Adapter: ${manifest.adapter}`,
      "- Result: skipped (documentation-only)",
    ]);
    return;
  }

  const policy = parseDeployPolicy(await readJson(policyPath));
  const eventType = deployEventType(policy, manifest.adapter);
  const requestId = [
    "deploy",
    process.env.GITHUB_RUN_ID ?? "0",
    process.env.GITHUB_RUN_ATTEMPT ?? "1",
    headSha.slice(0, 12),
  ].join("-");
  const payload = JSON.stringify({
    event_type: eventType,
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
    `- Adapter: ${manifest.adapter}`,
    `- Runner profile: ${manifest.runner_profile}`,
    `- Event: ${eventType}`,
    "- Result: dispatched",
  ]);
  console.log(`Central deploy dispatched: ${repository}@${headSha} -> ${manifest.adapter} -> ${eventType}`);
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
