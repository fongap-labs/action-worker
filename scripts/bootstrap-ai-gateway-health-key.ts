import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { listWorkerSecretNames, putWorkerSecret } from "./ai-gateway-ops.ts";
import { runText } from "./runtime-command.ts";

const controlRepository = "fongap-labs/action-worker";
const healthSecret = "AIG_DEPLOY_HEALTH_KEY";
const environments = ["ai-gateway-ops"] as const;

/** A partial secret name list must never authorize creating a new credential. */
export function environmentSecretNames(value: unknown): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("GitHub Environment secret inventory is invalid.");
  }
  const result = value as Record<string, unknown>;
  if (
    typeof result.total_count !== "number" ||
    !Number.isSafeInteger(result.total_count) ||
    result.total_count < 0 ||
    !Array.isArray(result.secrets) ||
    result.total_count !== result.secrets.length
  ) {
    throw new Error("GitHub Environment secret inventory is incomplete.");
  }
  const names: string[] = [];
  for (const item of result.secrets) {
    if (
      typeof item !== "object" ||
      item === null ||
      Array.isArray(item) ||
      typeof (item as Record<string, unknown>).name !== "string"
    ) {
      throw new Error("GitHub Environment secret inventory has an invalid entry.");
    }
    names.push((item as { name: string }).name);
  }
  if (new Set(names).size !== names.length) {
    throw new Error("GitHub Environment secret inventory contains duplicate names.");
  }
  return names;
}

export function assertHealthKeyIsUninitialized(
  workerNames: readonly string[],
  environmentNames: readonly (readonly string[])[]
): void {
  if (
    environmentNames.length !== environments.length ||
    workerNames.includes(healthSecret) ||
    environmentNames.some((names) => names.includes(healthSecret))
  ) {
    throw new Error(
      "Deployment health Secret already exists or inventory is incomplete; refusing to rotate it."
    );
  }
}

function assertTrustedMain(): void {
  if (
    process.env.GITHUB_ACTIONS !== "true" ||
    process.env.GITHUB_REPOSITORY !== controlRepository ||
    process.env.GITHUB_REF !== "refs/heads/main"
  ) {
    throw new Error("Health-key bootstrap requires the approved main-branch workflow.");
  }
}

/** Read-only preflight using the existing protected deployment credential domain. */
async function preflightWorker(): Promise<void> {
  const names = await listWorkerSecretNames(process.env);
  assertHealthKeyIsUninitialized(names, [[]]);
  console.log("Worker health-key name is absent; bootstrap may proceed.");
}

/** Write once using the existing admin-ops credential; no App permission escalation. */
async function bootstrapGithubEnvironments(): Promise<void> {
  if (!process.env.GH_TOKEN) {
    throw new Error("Protected admin-ops secret management token is required.");
  }
  const githubNames: string[][] = [];
  for (const environment of environments) {
    const response = await runText(
      "gh",
      [
        "api",
        "repos/" + controlRepository + "/environments/" + environment + "/secrets?per_page=100",
      ],
      { timeoutMs: 30000, maxBuffer: 1024 * 1024 }
    );
    githubNames.push(environmentSecretNames(JSON.parse(response)));
  }
  assertHealthKeyIsUninitialized([], githubNames);

  const value = randomBytes(32).toString("hex");
  for (const environment of environments) {
    // gh encrypts the secret with the Environment public key; stdin only.
    await runText(
      "gh",
      ["secret", "set", healthSecret, "--repo", controlRepository, "--env", environment],
      { input: value, timeoutMs: 30000, maxBuffer: 1024 * 1024 }
    );
  }
  console.log("Deployment health Secret initialized in the protected ai-gateway-ops Environment.");
}

/** Read the persisted Environment Secret in a fresh, protected job. */
async function publishWorker(): Promise<void> {
  const value = process.env.AIG_DEPLOY_HEALTH_KEY;
  if (!value || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(
      "Newly initialized health credential is not available in the ai-gateway-ops Environment."
    );
  }
  const names = await listWorkerSecretNames(process.env);
  assertHealthKeyIsUninitialized(names, [[]]);
  await putWorkerSecret(healthSecret, { ...process.env, AIG_OPS_SECRET_VALUE: value });
  console.log("Cloudflare health Secret initialized; remote health check passed.");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const operation = process.argv[2] ?? "";
  Promise.resolve()
    .then(() => {
      assertTrustedMain();
      if (operation === "worker-preflight") return preflightWorker();
      if (operation === "github-bootstrap") return bootstrapGithubEnvironments();
      if (operation === "worker-publish") return publishWorker();
      throw new Error("Unsupported deployment health bootstrap operation.");
    })
    .catch((error: unknown) => {
      console.error(
        "::error::Health-key bootstrap stopped. A partial write may require controlled reconciliation: " +
          (error instanceof Error ? error.message : "unknown error.")
      );
      process.exitCode = 1;
    });
}
