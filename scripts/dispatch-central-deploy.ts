import {
  type DeployAdapter,
  parseDeployPlan,
  type ResolvedDeployManifest,
  resolveDeployManifest,
  wholeRepositoryPath,
} from "./deploy-manifest.ts";
import {
  GithubHttpError,
  GithubReader,
  getJsonArray,
  getJsonString,
  githubEnvironment,
  isJsonRecord,
} from "./github-api.ts";
import { type ContentReader, discoverProducts } from "./product-discovery.ts";
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

function changedFiles(commitOrComparison: unknown): string[] {
  return getJsonArray(commitOrComparison, "files")
    .filter(isJsonRecord)
    .map((item) => getJsonString(item, "filename"))
    .filter(Boolean);
}

export function deployPathMatches(paths: readonly string[], file: string): boolean {
  return paths.some((path) => {
    if (path === wholeRepositoryPath) {
      return true;
    }
    return path.endsWith("/**") ? file.startsWith(path.slice(0, -2)) : file === path;
  });
}

export type DeployDecision = "deploy" | "path-unchanged" | "documentation-only";

// Only the changed files under the trigger paths count, so documentation outside them neither
// starts nor blocks a deploy of the environment.
export function deployDecision(
  paths: readonly string[],
  isDocsOnlyIgnored: boolean,
  files: readonly string[]
): DeployDecision {
  const scoped = files.filter((file) => deployPathMatches(paths, file));
  if (scoped.length === 0 && !paths.includes(wholeRepositoryPath)) {
    return "path-unchanged";
  }
  if (isDocsOnlyIgnored && isDocsOnly(scoped)) {
    return "documentation-only";
  }
  return "deploy";
}

/**
 * Main moved on while central CI ran for an older commit. The newer commit normally deploys
 * itself after its own central CI. When the newer commit would not deploy this environment (its
 * changes are documentation the source skips, or they miss the trigger paths), the older commit's
 * change would never reach production; the current HEAD carries that change and is deployed instead.
 */
export function shouldDeployCurrentMain(
  comparison: unknown,
  isDocsOnlyIgnored: boolean,
  paths: readonly string[] = [wholeRepositoryPath]
): boolean {
  if (getJsonString(comparison, "status") !== "ahead") {
    return false;
  }
  const files = changedFiles(comparison);
  if (files.length >= comparisonFileLimit) {
    return false;
  }
  return deployDecision(paths, isDocsOnlyIgnored, files) !== "deploy";
}

// An automatic deploy runs without a person, so an environment that requires reviewers can never
// finish it. A missing read is refused too: the check never passes by default.
export async function assertNoRequiredReviewers(
  reader: ContentReader,
  controlRepository: string,
  environment: string
): Promise<void> {
  let response: unknown;
  try {
    response = await reader.get(`repos/${controlRepository}/environments/${environment}`);
  } catch (error) {
    if (error instanceof GithubHttpError) {
      throw new CliError(
        `Environment ${environment} cannot be read with AW_CONTROL_TOKEN (HTTP ${error.status}); automatic deploy is refused.`,
        77
      );
    }
    throw error;
  }
  const rules =
    isJsonRecord(response) && Array.isArray(response.protection_rules)
      ? response.protection_rules
      : undefined;
  if (rules === undefined) {
    throw new CliError(`GitHub environment response has no protection rules: ${environment}.`, 65);
  }
  if (rules.some((rule) => isJsonRecord(rule) && rule.type === "required_reviewers")) {
    throw new CliError(
      `Environment ${environment} requires reviewers, so an automatic deploy cannot finish. Remove the required reviewers from the environment, or remove the push trigger from the source manifest.`,
      77
    );
  }
}

export type AutomaticDeployTarget = {
  product: string;
  environment: string;
};

// Every product and environment whose source manifest declares a push trigger, at the current HEAD.
export async function automaticDeployTargets(
  reader: ContentReader,
  repository: string,
  sha: string,
  controlRepository: string
): Promise<AutomaticDeployTarget[]> {
  const discovery = await discoverProducts(reader, repository, sha);
  const targets: AutomaticDeployTarget[] = [];
  for (const product of discovery.products) {
    const text = product.files["deploy.json"];
    if (text === undefined) {
      continue;
    }
    const plan = parseDeployPlan(text, repository);
    for (const environment of plan.environments) {
      if (environment.declares_triggers) {
        await assertNoRequiredReviewers(reader, controlRepository, environment.environment);
      }
      if (environment.push_paths !== null) {
        targets.push({ product: product.name, environment: environment.environment });
      }
    }
  }
  return targets;
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

  // The current HEAD decides whether and how each product and environment deploys.
  const targets = await automaticDeployTargets(reader, repository, defaultSha, controlRepository);
  if (targets.length === 0) {
    console.log(`Automatic deploy is disabled by source manifest: ${repository}`);
    return;
  }

  const comparison =
    defaultSha === headSha
      ? undefined
      : await reader.get(`repos/${repository}/compare/${headSha}...${defaultSha}`);
  // A main that was rewritten (not ahead of HEAD) is skipped below, so HEAD is read only when the
  // decision needs its changed files; a rewritten HEAD may no longer be served.
  const needsHeadFiles =
    comparison === undefined || getJsonString(comparison, "status") === "ahead";
  const headFiles = needsHeadFiles
    ? changedFiles(await reader.get(`repos/${repository}/commits/${headSha}`))
    : [];
  const policy = parseDeployPolicy(await readJson(policyPath));
  const runnerPolicy = await readJson(runnerPolicyPath);

  for (const [index, target] of targets.entries()) {
    const manifest: ResolvedDeployManifest = await resolveDeployManifest(
      repository,
      defaultSha,
      repositoryPolicy,
      runnerPolicy,
      reader,
      undefined,
      { product: target.product, environment: target.environment }
    );
    const label = `${repository} ${target.product || "(root)"} ${target.environment}`;
    if (!manifest.automatic) {
      console.log(`Automatic deploy is disabled by source manifest: ${label}`);
      continue;
    }
    const paths = manifest.push_paths ?? [];

    const skip = async (reason: string): Promise<void> => {
      console.log(`Automatic deploy skipped (${reason}): ${label}@${headSha}`);
      await appendLines(process.env.GITHUB_STEP_SUMMARY, [
        "## Central deploy dispatch",
        "",
        `- Repository: ${repository}`,
        `- Product: ${target.product || "(root)"}`,
        `- Environment: ${target.environment}`,
        `- Commit: ${headSha}`,
        `- Adapter: ${manifest.adapter}`,
        `- Result: skipped (${reason})`,
      ]);
    };

    if (!needsHeadFiles) {
      await skip(`main moved on to ${defaultSha}, which deploys after its own central CI`);
      continue;
    }
    const decision = deployDecision(paths, manifest.ignore_docs_only, headFiles);
    let deploySha = headSha;
    if (decision === "path-unchanged") {
      await skip("no push path changed");
      continue;
    }
    if (defaultSha === headSha) {
      if (decision === "documentation-only") {
        await skip("documentation-only");
        continue;
      }
    } else if (!shouldDeployCurrentMain(comparison, manifest.ignore_docs_only, paths)) {
      await skip(`main moved on to ${defaultSha}, which deploys after its own central CI`);
      continue;
    } else {
      console.log(
        `Main moved on to ${defaultSha} with documentation or out-of-path changes only, so the current main is deployed with this change.`
      );
      deploySha = defaultSha;
    }

    const eventType = deployEventType(policy, manifest.adapter);
    const requestId = [
      "deploy",
      process.env.GITHUB_RUN_ID ?? "0",
      process.env.GITHUB_RUN_ATTEMPT ?? "1",
      deploySha.slice(0, 12),
      String(index),
    ].join("-");
    const payload = JSON.stringify({
      event_type: eventType,
      client_payload: {
        schema_version: "1",
        request_id: requestId,
        source_repository: repository,
        source_sha: deploySha,
        product: target.product,
        environment: target.environment,
        trigger: "push",
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
      `- Product: ${target.product || "(root)"}`,
      `- Environment: ${target.environment}`,
      `- Commit: ${deploySha}`,
      `- Adapter: ${manifest.adapter}`,
      `- Runner profile: ${manifest.runner_profile}`,
      `- Event: ${eventType}`,
      "- Result: dispatched",
    ]);
    console.log(
      `Central deploy dispatched: ${label}@${deploySha} -> ${manifest.adapter} -> ${eventType}`
    );
  }
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
