import {
  assertBetaDeployTrigger,
  readBetaDeployPolicy,
  resolveBetaDeployTarget,
  verifyBetaDeploySource,
} from "./beta-deploy-authorization.ts";
import { assertBetaPushReceipt } from "./beta-push-dispatch.ts";
import {
  assertBranchDeployEnvironment,
  assertMainPublicationBranch,
} from "./branch-publication-policy.ts";
import {
  centralCiWait,
  defaultControlRepository,
  requireVerifiedCiEvidence,
} from "./ci-evidence.ts";
import {
  type DeployAdapter,
  isDeployEnvironmentName,
  type ResolvedDeployManifest,
  resolveDeployManifest,
} from "./deploy-manifest.ts";
import { productPolicyKey } from "./deploy-policy-key.ts";
import { GithubReader, getJsonString, isJsonRecord } from "./github-api.ts";
import { assertTrustedMainWrite } from "./main-write-guard.ts";
import { discoverProducts, isProductName, selectProduct } from "./product-discovery.ts";
import { readRepositoryPolicyText } from "./repository-policy.ts";
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
  source_branch?: "main" | "dev";
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
const optionalKeys = ["environment", "product", "source_branch", "trigger"];

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
    (value.source_branch !== undefined &&
      value.source_branch !== "main" &&
      value.source_branch !== "dev") ||
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
  if (value.source_branch === "dev") {
    if (
      value.environment !== "beta" ||
      !["manual", "schedule", "push"].includes(String(value.trigger))
    ) {
      throw new CliError("Dev deployment requires an explicit Beta request and trigger.", 65);
    }
  } else if (value.environment === "beta") {
    throw new CliError("Beta deployment cannot use the main branch.", 65);
  }
  return value as DeployRequest;
}

/** Scheduled Beta ingress cannot masquerade as a manual request. */
export function assertBetaDeployIngress(request: DeployRequest, event: string): void {
  if (request.source_branch !== "dev") return;
  if (
    (event === "workflow_dispatch" && request.trigger === "manual") ||
    (event === "repository_dispatch" &&
      (request.trigger === "schedule" || request.trigger === "push"))
  ) {
    return;
  }
  throw new CliError("Beta deployment ingress does not match the authorized trigger.", 75);
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

// A request names the trigger that started it; the source manifest must declare that trigger for the
// environment, so a request cannot deploy an environment on a trigger it does not have.
export function assertDeployTrigger(
  trigger: DeployTrigger,
  manifest: Pick<ResolvedDeployManifest, "automatic" | "schedule" | "environment">
): void {
  if (trigger === "push" && !manifest.automatic) {
    throw new CliError(
      `::error::Push deploy requires a push trigger, and the source manifest declares none for ${manifest.environment}.`,
      65
    );
  }
  if (trigger === "schedule" && manifest.schedule.length === 0) {
    throw new CliError(
      `::error::Scheduled deploy requires a schedule, and the source manifest declares none for ${manifest.environment}.`,
      65
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
  const rawRepositoryPolicy = readRepositoryPolicyText() ?? "";
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
  assertMainPublicationBranch(defaultBranch);
  const branch = request.source_branch ?? "main";
  if (request.environment) assertBranchDeployEnvironment(branch, request.environment);
  assertBetaDeployIngress(request, process.env.GITHUB_EVENT_NAME ?? "");
  if (
    branch === "dev" &&
    (process.env.GITHUB_REPOSITORY !== defaultControlRepository ||
      process.env.GITHUB_REF !== "refs/heads/main" ||
      !isJsonRecord(repository) ||
      repository.private !== false)
  ) {
    throw new CliError("Beta deployment requires trusted central control and a public source.", 75);
  }
  const defaultCommit = await reader.get(`repos/${request.source_repository}/commits/${branch}`);
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
  if ((branch === "dev" || requireDefaultHeadRaw === "true") && resolvedSha !== defaultSha) {
    throw new CliError(
      `::error::Deploy source is stale; default HEAD moved: expected=${defaultSha} actual=${resolvedSha}.`,
      75
    );
  }

  const trigger = request.trigger ?? "manual";
  const discovery = await discoverProducts(reader, request.source_repository, resolvedSha);
  const product = selectProduct(discovery.products, request.product ?? "");
  if (product.files["deploy.json"] === undefined) {
    throw new CliError(
      `::error::Deploy manifest is missing for the requested product: ${product.directory || "(root)"}.`,
      65
    );
  }
  const betaTarget =
    branch === "dev"
      ? resolveBetaDeployTarget(readBetaDeployPolicy(), request.source_repository, product.name)
      : undefined;
  const environmentPolicy =
    branch === "dev"
      ? {
          schema_version: 1,
          repositories: { [productPolicyKey(request.source_repository, product.name)]: ["beta"] },
        }
      : await readJson(environmentPolicyPath);
  const manifest = await resolveDeployManifest(
    request.source_repository,
    resolvedSha,
    parseJson(rawRepositoryPolicy, "AW_REPOSITORY_POLICY must be valid JSON.", 65),
    await readJson(runnerPolicyPath),
    reader,
    environmentPolicy,
    { product: product.name, environment: request.environment ?? "" }
  );
  if (manifest.adapter !== expectedAdapter) {
    throw new CliError(
      `::error::Deploy adapter mismatch: expected=${expectedAdapter} actual=${manifest.adapter}.`,
      65
    );
  }
  assertBranchDeployEnvironment(branch, manifest.environment);
  assertDeployTrigger(trigger, manifest);

  let writePr: number;
  if (branch === "dev") {
    if (!betaTarget) throw new CliError("Beta deployment target is unavailable.", 77);
    assertBetaDeployTrigger(betaTarget, trigger, manifest);
    if (trigger === "push") {
      await assertBetaPushReceipt(
        reader,
        request.source_repository,
        product.name,
        resolvedSha,
        request.request_id
      );
    }
    if (
      manifest.runner_backend !== "github-hosted" ||
      manifest.runner_labels_json !== '["ubuntu-24.04"]'
    ) {
      throw new CliError("Beta deployment requires an isolated hosted runner.", 75);
    }
    writePr = await verifyBetaDeploySource(
      reader,
      request.source_repository,
      resolvedSha,
      defaultControlRepository
    );
  } else {
    // The main deployment requests central CI immediately before validation.
    await requireVerifiedCiEvidence(reader, request.source_repository, resolvedSha, centralCiWait);
    const mainWrite = await assertTrustedMainWrite(
      reader,
      request.source_repository,
      resolvedSha,
      true
    );
    writePr = mainWrite.pr_number;
  }

  await appendLines(process.env.GITHUB_OUTPUT, [
    `source_repository=${request.source_repository}`,
    `source_sha=${resolvedSha}`,
    `default_branch=${defaultBranch}`,
    `source_branch=${branch}`,
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
    `- Source branch: ${branch}`,
    `- Adapter: ${manifest.adapter}`,
    `- Environment: ${manifest.environment}`,
    `- Trigger: ${trigger}`,
    `- Runner profile: ${manifest.runner_profile}`,
    `- Require default HEAD: ${requireDefaultHeadRaw}`,
    `- ${branch === "dev" ? "Dev" : "Central"} CI Evidence: verified Action Worker success`,
    `- ${branch === "dev" ? "Dev" : "Main"} Write Guard: success via PR #${writePr}`,
  ]);
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
