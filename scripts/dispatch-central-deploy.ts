import { type DeployAdapter, resolveDeployManifest } from "./deploy-manifest.ts";
import {
  GithubReader,
  getJsonArray,
  getJsonString,
  githubEnvironment,
  isJsonRecord,
} from "./github-api.ts";
import { hasRepositoryCapability } from "./repository-policy.ts";
import {
  appendLines,
  CliError,
  handleError,
  isMain,
  parseJson,
  readJson,
  runText,
} from "./runtime-command.ts";

type DeployAdapterPolicy = {
  event_type: string;
};

type DeployPolicy = {
  schema_version: 2;
  adapters: {
    "source-script": DeployAdapterPolicy;
  };
};

const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const eventPattern = /^[A-Za-z0-9._:-]{1,100}$/;
const shaPattern = /^[0-9a-f]{40}$/;

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length && actual.every((item, index) => item === expected[index])
  );
}

export function parseDeployPolicy(value: unknown): DeployPolicy {
  if (
    !isJsonRecord(value) ||
    !exactKeys(value, ["adapters", "schema_version"]) ||
    value.schema_version !== 2 ||
    !isJsonRecord(value.adapters)
  ) {
    throw new CliError("Deploy adapter policy is invalid.", 65);
  }

  if (!exactKeys(value.adapters, ["source-script"])) {
    throw new CliError("Deploy adapter policy must contain only source-script.", 65);
  }
  const raw = value.adapters["source-script"];
  if (
    !isJsonRecord(raw) ||
    !exactKeys(raw, ["event_type"]) ||
    typeof raw.event_type !== "string" ||
    !eventPattern.test(raw.event_type)
  ) {
    throw new CliError("Deploy source-script executor policy is invalid.", 65);
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
  return (
    paths.length > 0 && paths.every((path) => path.endsWith(".md") || path.startsWith("docs/"))
  );
}

// GitHub lists at most 300 files in a comparison, so a longer list may hide code changes.
const comparisonFileLimit = 300;

/**
 * Main moved on while central CI ran for an older commit. The newer commit normally deploys
 * itself after its own central CI. When everything after the older commit is documentation that
 * the source skips, the newer commit will not deploy, so the older commit's change would never
 * reach production; the current HEAD carries that change and is deployed instead.
 */
export function shouldDeployCurrentMain(comparison: unknown, isDocsOnlyIgnored: boolean): boolean {
  if (!isDocsOnlyIgnored || getJsonString(comparison, "status") !== "ahead") {
    return false;
  }
  const files = getJsonArray(comparison, "files")
    .filter(isJsonRecord)
    .map((item) => getJsonString(item, "filename"))
    .filter(Boolean);
  return files.length < comparisonFileLimit && isDocsOnly(files);
}

async function main(): Promise<void> {
  const [
    repository = "",
    headSha = "",
    prNumberRaw = "",
    policyPath = "policies/deploy.json",
    runnerPolicyPath = "policies/runner.json",
  ] = process.argv.slice(2);

  if (
    !repositoryPattern.test(repository) ||
    !shaPattern.test(headSha) ||
    !/^\d+$/.test(prNumberRaw)
  ) {
    throw new CliError(
      "Usage: dispatch-central-deploy.ts <repository> <head-sha> <pr-number> [adapter-policy] [runner-policy]",
      64
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
  if (
    !controlToken ||
    !dispatchToken ||
    !rawRepositoryPolicy ||
    !repositoryPattern.test(controlRepository)
  ) {
    throw new CliError(
      "Central deploy runtime credentials or repository policy are unavailable.",
      77
    );
  }

  const repositoryPolicy = parseJson(
    rawRepositoryPolicy,
    "AW_REPOSITORY_POLICY must be valid JSON.",
    65
  );
  if (!hasRepositoryCapability(repository, repositoryPolicy, "deploy")) {
    // Most managed repositories have no deploy target; a green main push must not end in a red run.
    console.log(`Automatic deploy skipped: ${repository} does not have the deploy capability.`);
    return;
  }

  const reader = new GithubReader(
    process.env.GITHUB_API_URL ?? "https://api.github.com",
    controlToken
  );
  const repositoryJson = await reader.get(`repos/${repository}`);
  const defaultBranch = getJsonString(repositoryJson, "default_branch");
  const defaultCommit = await reader.get(`repos/${repository}/commits/${defaultBranch}`);
  const defaultSha = getJsonString(defaultCommit, "sha");
  if (!shaPattern.test(defaultSha)) {
    throw new CliError(`Automatic deploy source default HEAD is invalid: ${repository}.`, 65);
  }

  // The current HEAD decides whether and how the source deploys.
  const manifest = await resolveDeployManifest(
    repository,
    defaultSha,
    repositoryPolicy,
    await readJson(runnerPolicyPath),
    reader
  );
  if (!manifest.automatic) {
    console.log(`Automatic deploy is disabled by source manifest: ${repository}`);
    return;
  }

  const skip = async (reason: string): Promise<void> => {
    console.log(`Automatic deploy skipped (${reason}): ${repository}@${headSha}`);
    await appendLines(process.env.GITHUB_STEP_SUMMARY, [
      "## Central deploy dispatch",
      "",
      `- Repository: ${repository}`,
      `- Commit: ${headSha}`,
      `- Adapter: ${manifest.adapter}`,
      `- Result: skipped (${reason})`,
    ]);
  };

  let deploySha = headSha;
  if (defaultSha !== headSha) {
    const comparison = await reader.get(`repos/${repository}/compare/${headSha}...${defaultSha}`);
    if (!shouldDeployCurrentMain(comparison, manifest.ignore_docs_only)) {
      await skip(`main moved on to ${defaultSha}, which deploys after its own central CI`);
      return;
    }
    console.log(
      `Main moved on to ${defaultSha} with documentation only, so the current main is deployed with this change.`
    );
    deploySha = defaultSha;
  } else {
    const commit = await reader.get(`repos/${repository}/commits/${headSha}`);
    const changedFiles = getJsonArray(commit, "files")
      .filter(isJsonRecord)
      .map((item) => getJsonString(item, "filename"))
      .filter(Boolean);
    if (manifest.ignore_docs_only && isDocsOnly(changedFiles)) {
      await skip("documentation-only");
      return;
    }
  }

  const policy = parseDeployPolicy(await readJson(policyPath));
  const eventType = deployEventType(policy, manifest.adapter);
  const requestId = [
    "deploy",
    process.env.GITHUB_RUN_ID ?? "0",
    process.env.GITHUB_RUN_ATTEMPT ?? "1",
    deploySha.slice(0, 12),
  ].join("-");
  const payload = JSON.stringify({
    event_type: eventType,
    client_payload: {
      schema_version: "1",
      request_id: requestId,
      source_repository: repository,
      source_sha: deploySha,
    },
  });

  await runText(
    "gh",
    ["api", "--method", "POST", `repos/${controlRepository}/dispatches`, "--input", "-"],
    {
      env: githubEnvironment(dispatchToken),
      input: payload,
    }
  );

  await appendLines(process.env.GITHUB_STEP_SUMMARY, [
    "## Central deploy dispatch",
    "",
    `- Repository: ${repository}`,
    `- Commit: ${deploySha}`,
    `- Adapter: ${manifest.adapter}`,
    `- Runner profile: ${manifest.runner_profile}`,
    `- Event: ${eventType}`,
    "- Result: dispatched",
  ]);
  console.log(
    `Central deploy dispatched: ${repository}@${deploySha} -> ${manifest.adapter} -> ${eventType}`
  );
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
