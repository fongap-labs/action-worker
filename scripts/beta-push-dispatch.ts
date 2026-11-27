import { createHash } from "node:crypto";
import {
  assertBetaDeployTrigger,
  hasBetaPushGrant,
  parseBetaDeployTargets,
  verifyBetaDeploySource,
} from "./beta-deploy-authorization.ts";
import type { JsonReader } from "./ci-evidence.ts";
import { parseDeployPlan } from "./deploy-manifest.ts";
import { productPolicyKey } from "./deploy-policy-key.ts";
import { deployDecision } from "./dispatch-central-deploy.ts";
import { getGithubJsonIfExists, getJsonArray, getJsonString, isJsonRecord } from "./github-api.ts";
import { discoverProducts } from "./product-discovery.ts";
import { repositoriesForCapability } from "./repository-policy.ts";
import { CliError } from "./runtime-command.ts";
import {
  dispatchWithReservation,
  hasScheduledDispatchReceipt,
  writeScheduledDispatchStatus,
} from "./scheduled-dispatch-statuses.ts";
import { assertExistingCredentialEnvironment } from "./verify-deploy-credential-environment.ts";

export function betaPushIdentity(repository: string, product: string, sha: string): string {
  const digest = createHash("sha256")
    .update(`${repository}\n${product}\nbeta\n${sha}`)
    .digest("hex")
    .slice(0, 32);
  return `deploy-beta-push-${digest}`;
}

export function betaPushContext(product: string): string {
  return product ? `Beta Deploy Push/${product}` : "Beta Deploy Push";
}

const receipts = [
  { state: "pending" as const, description: "Beta push dispatch reserved" },
  { state: "success" as const, description: "Beta push dispatched" },
];

export async function assertBetaPushReceipt(
  reader: JsonReader,
  repository: string,
  product: string,
  sha: string,
  requestId: string
): Promise<void> {
  if (
    requestId !== betaPushIdentity(repository, product, sha) ||
    !(await hasScheduledDispatchReceipt(
      repository,
      sha,
      betaPushContext(product),
      receipts,
      (path) => reader.get(path)
    ))
  ) {
    throw new CliError("Beta push deployment lacks a signed central dispatch receipt.", 77);
  }
}

type BetaPushOptions = {
  reader: JsonReader;
  repositoryPolicy: unknown;
  betaPolicy: unknown;
  controlRepository: string;
  onlyRepository: string;
  eventType: string;
  statusToken: string;
  dispatch(body: string): Promise<void>;
};

export type BetaPushCandidate = {
  repository: string;
  product: string;
  sha: string;
  credential_environment: string;
};

/** Coalesce onto current dev HEAD; no historical commits are replayed. */
export async function resolveBetaPushCandidates(
  options: Pick<
    BetaPushOptions,
    "reader" | "repositoryPolicy" | "betaPolicy" | "controlRepository" | "onlyRepository"
  >
): Promise<BetaPushCandidate[]> {
  const { reader, repositoryPolicy, betaPolicy, controlRepository, onlyRepository } = options;
  const grants = parseBetaDeployTargets(betaPolicy);
  const candidates: BetaPushCandidate[] = [];
  for (const repository of repositoriesForCapability(repositoryPolicy, "deploy")) {
    if (
      repository === controlRepository ||
      (onlyRepository && repository !== onlyRepository) ||
      !hasBetaPushGrant(grants, repository)
    ) {
      continue;
    }
    const repo = await reader.get(`repos/${repository}`);
    if (
      !isJsonRecord(repo) ||
      repo.full_name !== repository ||
      repo.private !== false ||
      repo.default_branch !== "main"
    ) {
      continue;
    }
    const head = await getGithubJsonIfExists(`repos/${repository}/commits/dev`, (path) =>
      reader.get(path)
    );
    if (head === undefined) continue;
    const sha = getJsonString(head, "sha");
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new CliError("Invalid Beta push HEAD.", 65);
    const commit = await reader.get(`repos/${repository}/commits/${sha}`);
    const files = getJsonArray(commit, "files").map((file) => getJsonString(file, "filename"));
    // A truncated or malformed comparison cannot prove which source paths changed.
    if (!files.length || files.length >= 300 || files.some((file) => !file)) continue;
    const discovery = await discoverProducts(reader, repository, sha);
    for (const product of discovery.products) {
      const grant = grants.get(productPolicyKey(repository, product.name));
      const text = product.files["deploy.json"];
      if (grant?.allow_push !== true || text === undefined) continue;
      const plan = parseDeployPlan(text, repository);
      const beta = plan.environments.find((item) => item.environment === "beta");
      if (!beta || beta.push_paths === null || plan.adapter !== "source-script") continue;
      assertBetaDeployTrigger(grant, "push", { automatic: true, schedule: beta.schedule });
      if (deployDecision(beta.push_paths, plan.ignore_docs_only, files) !== "deploy") continue;
      candidates.push({
        repository,
        product: product.name,
        sha,
        credential_environment: grant.credential_environment,
      });
    }
  }
  return candidates;
}

export async function dispatchBetaPushDeploys(options: BetaPushOptions): Promise<number> {
  const { reader, controlRepository, statusToken, eventType, dispatch } = options;
  let count = 0;
  for (const candidate of await resolveBetaPushCandidates(options)) {
    const { repository, product, sha } = candidate;
    const context = betaPushContext(product);
    if (
      await hasScheduledDispatchReceipt(repository, sha, context, receipts, (path) =>
        reader.get(path)
      )
    ) {
      continue;
    }
    try {
      await verifyBetaDeploySource(reader, repository, sha, controlRepository);
    } catch (error) {
      if (!(error instanceof CliError)) throw error;
      console.log(`Beta push source proof not ready: ${repository}@${sha}`);
      continue;
    }
    await assertExistingCredentialEnvironment(
      reader,
      controlRepository,
      candidate.credential_environment
    );
    const target = { repository, head_sha: sha, context };
    await dispatchWithReservation(
      () => writeScheduledDispatchStatus(target, statusToken, "pending", receipts[0]!.description),
      () =>
        dispatch(
          JSON.stringify({
            event_type: eventType,
            client_payload: {
              schema_version: "1",
              request_id: betaPushIdentity(repository, product, sha),
              source_repository: repository,
              source_sha: sha,
              source_branch: "dev",
              product,
              environment: "beta",
              trigger: "push",
            },
          })
        ),
      () => writeScheduledDispatchStatus(target, statusToken, "success", receipts[1]!.description)
    );
    count += 1;
  }
  return count;
}
