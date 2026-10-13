import { centralCiWait, requireVerifiedCiEvidence } from "./ci-evidence.ts";
import {
  type DeployAdapter,
  isDeployEnvironmentName,
  resolveDeployManifest,
} from "./deploy-manifest.ts";
import { GithubReader, getJsonString, isJsonRecord } from "./github-api.ts";
import { assertTrustedMainWrite } from "./main-write-guard.ts";
import { discoverProducts, isProductName, selectProduct } from "./product-discovery.ts";
import {
  appendLines,
  CliError,
  handleError,
  isMain,
  parseJson,
  readJson,
} from "./runtime-command.ts";

export type DeployTrigger = "manual" | "push" | "schedule";

export type DeployRequest = {
  schema_version: "1";
  request_id: string;
  source_repository: string;
  source_sha: string;
  // Optional: empty or absent selects the only product (or the root manifest) of the source.
  product?: string;
  environment?: string;
  trigger?: DeployTrigger;
};

const requestPattern = /^[A-Za-z0-9._:-]{1,128}$/;
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const shaPattern = /^[0-9a-f]{40}$/;
const triggers: readonly string[] = ["manual", "push", "schedule"];
const requiredKeys = ["request_id", "schema_version", "source_repository", "source_sha"];
const optionalKeys = ["environment", "product", "trigger"];

function hasOnlyKeys(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value);
  return (
    requiredKeys.every((key) => key in value) &&
    keys.every((key) => requiredKeys.includes(key) || optionalKeys.includes(key))
  );
}

export function parseDeployRequest(value: unknown): DeployRequest {
  if (
    !isJsonRecord(value) ||
    !hasOnlyKeys(value) ||
    value.schema_version !== "1" ||
    typeof value.request_id !== "string" ||
    !requestPattern.test(value.request_id) ||
    typeof value.source_repository !== "string" ||
    !repositoryPattern.test(value.source_repository) ||
    typeof value.source_sha !== "string" ||
    !shaPattern.test(value.source_sha) ||
    (value.product !== undefined &&
      (typeof value.product !== "string" ||
        (value.product !== "" && !isProductName(value.product)))) ||
    (value.environment !== undefined &&
      (typeof value.environment !== "string" ||
        (value.environment !== "" && !isDeployEnvironmentName(value.environment)))) ||
    (value.trigger !== undefined &&
      (typeof value.trigger !== "string" || !triggers.includes(value.trigger)))
  ) {
    throw new CliError("::error::Deploy request is invalid.", 64);
  }
  return value as DeployRequest;
}

export function assertExpectedRepository(request: DeployRequest, expectedRepository: string): void {
  if (!expectedRepository) {
    return;
  }
  if (
    !repositoryPattern.test(expectedRepository) ||
    request.source_repository !== expectedRepository
  ) {
    throw new CliError(
      "::error::Deploy request repository does not match the executor contract.",
      64
    );
  }
}

async function main(): Promise<void> {
  const [
    expectedAdapterRaw = "",
    requireDefaultHeadRaw = "true",
    runnerPolicyPath = "policies/runner.json",
    environmentPolicyPath = "policies/deploy-environments.json",
  ] = process.argv.slice(2);

  if (
    !["cloudflare-worker", "source-script"].includes(expectedAdapterRaw) ||
    !["true", "false"].includes(requireDefaultHeadRaw)
  ) {
    throw new CliError(
      "Usage: validate-deploy-source.ts <expected-adapter> <require-default-head> [runner-policy] [environment-policy]",
      64
    );
  }
  const expectedAdapter = expectedAdapterRaw as DeployAdapter;

  const token = process.env.AW_CONTROL_TOKEN ?? "";
  const rawRequest = process.env.DEPLOY_REQUEST_JSON ?? "";
  const rawRepositoryPolicy = process.env.AW_REPOSITORY_POLICY ?? "";
  const expectedRepository = process.env.DEPLOY_EXPECTED_REPOSITORY ?? "";
  if (!token || !rawRepositoryPolicy) {
    throw new CliError("::error::AW_CONTROL_TOKEN and AW_REPOSITORY_POLICY are required.", 77);
  }
  if (!rawRequest) {
    throw new CliError("::error::DEPLOY_REQUEST_JSON is unavailable.", 64);
  }

  const request = parseDeployRequest(
    parseJson(rawRequest, "::error::DEPLOY_REQUEST_JSON must be valid JSON.", 64)
  );
  assertExpectedRepository(request, expectedRepository);

  const reader = new GithubReader(process.env.GITHUB_API_URL ?? "https://api.github.com", token);
  const repository = await reader.get(`repos/${request.source_repository}`);
  const defaultBranch = getJsonString(repository, "default_branch");
  const defaultCommit = await reader.get(
    `repos/${request.source_repository}/commits/${defaultBranch}`
  );
  const defaultSha = getJsonString(defaultCommit, "sha");
  if (!shaPattern.test(defaultSha)) {
    throw new CliError("::error::Deploy source default HEAD is invalid.", 65);
  }

  const commit = await reader.get(
    `repos/${request.source_repository}/commits/${request.source_sha}`
  );
  const resolvedSha = getJsonString(commit, "sha");
  if (resolvedSha !== request.source_sha) {
    throw new CliError("::error::Deploy source commit could not be resolved exactly.", 65);
  }
  if (requireDefaultHeadRaw === "true" && resolvedSha !== defaultSha) {
    throw new CliError(
      `::error::Deploy source is stale; default HEAD moved: expected=${defaultSha} actual=${resolvedSha}.`,
      75
    );
  }

  const trigger = request.trigger ?? "manual";
  if (trigger === "schedule") {
    throw new CliError("::error::Scheduled deploys are not enabled yet.", 64);
  }

  const discovery = await discoverProducts(reader, request.source_repository, resolvedSha);
  const product = selectProduct(discovery.products, request.product ?? "");
  if (product.files["deploy.json"] === undefined) {
    throw new CliError(
      `::error::Deploy manifest is missing for the requested product: ${product.directory || "(root)"}.`,
      65
    );
  }
  const manifest = await resolveDeployManifest(
    request.source_repository,
    resolvedSha,
    parseJson(rawRepositoryPolicy, "AW_REPOSITORY_POLICY must be valid JSON.", 65),
    await readJson(runnerPolicyPath),
    reader,
    await readJson(environmentPolicyPath),
    { product: product.name, environment: request.environment ?? "" }
  );
  if (manifest.adapter !== expectedAdapter) {
    throw new CliError(
      `::error::Deploy adapter mismatch: expected=${expectedAdapter} actual=${manifest.adapter}.`,
      65
    );
  }
  if (trigger === "push" && !manifest.automatic) {
    throw new CliError(
      `::error::Push deploy requires a push trigger, and the source manifest declares none for ${manifest.environment}.`,
      65
    );
  }

  // A manual deploy requests central CI for the commit just before this step, so wait for it.
  await requireVerifiedCiEvidence(reader, request.source_repository, resolvedSha, centralCiWait);

  const mainWrite = await assertTrustedMainWrite(
    reader,
    request.source_repository,
    resolvedSha,
    true
  );

  await appendLines(process.env.GITHUB_OUTPUT, [
    `source_repository=${request.source_repository}`,
    `source_sha=${resolvedSha}`,
    `default_branch=${defaultBranch}`,
    `adapter=${manifest.adapter}`,
    `product=${manifest.product}`,
    `product_directory=${manifest.product_directory}`,
    `trigger=${trigger}`,
    `runner_profile=${manifest.runner_profile}`,
    `runner_labels_json=${manifest.runner_labels_json}`,
    `environment=${manifest.environment}`,
    `entrypoint=${manifest.entrypoint}`,
  ]);

  await appendLines(process.env.GITHUB_STEP_SUMMARY, [
    "## Deploy source gate",
    "",
    `- Repository: ${request.source_repository}`,
    `- Product: ${manifest.product || "(root)"}`,
    `- Commit: ${resolvedSha}`,
    `- Default branch: ${defaultBranch}`,
    `- Adapter: ${manifest.adapter}`,
    `- Environment: ${manifest.environment}`,
    `- Trigger: ${trigger}`,
    `- Runner profile: ${manifest.runner_profile}`,
    `- Require default HEAD: ${requireDefaultHeadRaw}`,
    "- CI Evidence: verified Action Worker success",
    `- Main Write Guard: success via PR #${mainWrite.pr_number}`,
  ]);
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
