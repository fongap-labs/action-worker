import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { listWorkerSecretNames, putWorkerSecret } from "./ai-gateway-ops.ts";
import { runText } from "./runtime-command.ts";

const controlRepository = "fongap-labs/action-worker";
const healthSecret = "AIG_DEPLOY_HEALTH_KEY";
const environments = ["production", "ai-gateway-ops"] as const;

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

async function bootstrap(): Promise<void> {
  if (
    process.env.GITHUB_ACTIONS !== "true" ||
    process.env.GITHUB_REPOSITORY !== controlRepository ||
    process.env.GITHUB_REF !== "refs/heads/main" ||
    !process.env.GH_TOKEN
  ) {
    throw new Error("Health-key bootstrap requires the approved main-branch GitHub App job.");
  }
  const origin = process.env.AIG_PUBLIC_URL;
  let url: URL;
  try {
    url = new URL(origin ?? "");
  } catch {
    throw new Error("AIG_PUBLIC_URL is missing or invalid.");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("AIG_PUBLIC_URL must be an HTTPS origin.");
  }

  // Verify all three inventories before generating a value or writing anything.
  const remoteNames = await listWorkerSecretNames(process.env);
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
  assertHealthKeyIsUninitialized(remoteNames, githubNames);

  const value = randomBytes(32).toString("hex");
  // GitHub CLI encrypts each value with the Environment public key.
  // It is passed only through stdin, never command arguments, logs or artifacts.
  for (const environment of environments) {
    await runText(
      "gh",
      ["secret", "set", healthSecret, "--repo", controlRepository, "--env", environment],
      { input: value, timeoutMs: 30000, maxBuffer: 1024 * 1024 }
    );
  }
  // The existing protected operations path deploys the same value to the Worker
  // and checks the real HTTPS health probe. No placeholder code deployment occurs.
  await putWorkerSecret(healthSecret, { ...process.env, AIG_OPS_SECRET_VALUE: value });
  console.log("Deployment health Secret initialized in three scopes; remote health check passed.");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  bootstrap().catch((error: unknown) => {
    console.error(
      "::error::Health-key bootstrap stopped. A partial write may require controlled reconciliation: " +
        (error instanceof Error ? error.message : "unknown error.")
    );
    process.exitCode = 1;
  });
}
