import { fileURLToPath } from "node:url";

const workerNames = [
  "ai-gateway",
  "ai-inference-center",
  "ai-perception-center",
  "ai-generation-center",
] as const;
type WorkerName = (typeof workerNames)[number];
const gatewaySecretName =
  /^(?:AIG_(?:INFERENCE|PERCEPTION|GENERATION)_AUTH_KEY|AIG_ACCESS_KEY_(?:AIR|PRO|MAX|ULTRA|AGENT)|AIG_EDGE_CACHE_HMAC_KEY)$/;
const providerShardName = /^AIG_TIER[12]_CREDENTIALS_(?:0[1-9]|10)$/;
// Destructive operations are intentionally narrower than reads and writes.
const retiredGatewaySecretName =
  /^(?:AIG_TOKEN_ENCRYPTION_KEY|AIG_IS_SUBSCRIPTION_ENABLED|AIG_OAUTH_[A-Z0-9_]+|AIG_TIER3_[A-Z0-9_]+|AIG_TIER[12]_CREDENTIALS_(?:0[1-9]|10))$/;

function selectedWorker(env: OperationsEnvironment): WorkerName {
  const worker = env.AIG_OPS_WORKER_NAME || "ai-gateway";
  if (!workerNames.includes(worker as WorkerName)) {
    throw new Error("Requested Worker is outside the protected AI Gateway operations allowlist.");
  }
  return worker as WorkerName;
}

function allowedSecretForWorker(worker: WorkerName, name: string): boolean {
  if (worker === "ai-gateway") return gatewaySecretName.test(name);
  const auth = {
    "ai-inference-center": "AIG_INFERENCE_AUTH_KEY",
    "ai-perception-center": "AIG_PERCEPTION_AUTH_KEY",
    "ai-generation-center": "AIG_GENERATION_AUTH_KEY",
  }[worker];
  return name === auth || providerShardName.test(name);
}
export function validateSecretDeletion(name: string, env: OperationsEnvironment): void {
  const worker = selectedWorker(env);
  if (worker !== "ai-gateway" || !retiredGatewaySecretName.test(name)) {
    throw new Error("Only retired Gateway Secrets may be deleted by this operation.");
  }
  if (env.AIG_OPS_DELETE_CONFIRM !== `DELETE ai-gateway ${name}`) {
    throw new Error(
      "Explicit deletion confirmation must match the selected Worker and Secret name."
    );
  }
  if (providerShardName.test(name) && env.AIG_OPS_PROVIDERS_MIGRATED !== "true") {
    throw new Error(
      "Provider credential migration must be independently approved before Gateway shard deletion."
    );
  }
}
const maxSecretBytes = 4500;

type OperationsEnvironment = Record<string, string | undefined>;
type FetchFunction = typeof fetch;

type SecretEntry = { name: string; type: "secret_text" };

function assertString(value: string | undefined, label: string): string {
  if (typeof value !== "string" || value.length === 0 || !value.trim()) {
    throw new Error(`Missing required ai-gateway-ops configuration: ${label}`);
  }
  return value;
}

function validateCommon(env: OperationsEnvironment): { accountId: string; token: string } {
  const accountId = assertString(env.CLOUDFLARE_ACCOUNT_ID_OPS, "CLOUDFLARE_ACCOUNT_ID_OPS");
  const token = assertString(env.CLOUDFLARE_API_TOKEN_OPS, "CLOUDFLARE_API_TOKEN_OPS");
  if (!/^[0-9a-f]{32}$/.test(accountId)) {
    throw new Error(
      "CLOUDFLARE_ACCOUNT_ID_OPS must be a 32-character lowercase hexadecimal account ID."
    );
  }
  return { accountId, token };
}

export function validateSecretMutation(name: string, env: OperationsEnvironment): string {
  const worker = selectedWorker(env);
  if (!allowedSecretForWorker(worker, name))
    throw new Error("Requested secret is outside the selected Worker's allowlist.");
  const secretValue = assertString(env.AIG_OPS_SECRET_VALUE, "AIG_OPS_SECRET_VALUE");
  if (Buffer.byteLength(secretValue, "utf8") > maxSecretBytes) {
    throw new Error("Secret exceeds the Worker secret size limit; split credential shards first.");
  }
  if (
    (name === "AIG_INFERENCE_AUTH_KEY" ||
      name === "AIG_PERCEPTION_AUTH_KEY" ||
      name === "AIG_GENERATION_AUTH_KEY") &&
    secretValue.length < 32
  ) {
    throw new Error("Center authentication secret must contain at least 32 characters.");
  }
  return secretValue;
}

function cloudflareUrl(accountId: string, worker: WorkerName): string {
  return `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${worker}/secrets`;
}

async function requestCloudflare(
  fetcher: FetchFunction,
  url: string,
  token: string,
  method: "GET" | "PUT" | "DELETE",
  body?: { name: string; text: string; type: "secret_text" }
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetcher(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new Error("Cloudflare API request failed (network or timeout); secret state is unknown.");
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`Cloudflare API returned invalid JSON (HTTP ${response.status}).`);
  }
  if (
    !response.ok ||
    !payload ||
    typeof payload !== "object" ||
    (payload as Record<string, unknown>).success !== true
  ) {
    throw new Error(
      `Cloudflare API refused the request (HTTP ${response.status}); no token fallback is allowed.`
    );
  }
  return payload as Record<string, unknown>;
}

export async function listWorkerSecretNames(
  env: OperationsEnvironment,
  fetcher: FetchFunction = fetch
): Promise<string[]> {
  const worker = selectedWorker(env);
  const { accountId, token } = validateCommon(env);
  const data = await requestCloudflare(fetcher, cloudflareUrl(accountId, worker), token, "GET");
  if (!Array.isArray(data.result)) throw new Error("Cloudflare secret inventory is not an array.");
  const entries = data.result as unknown[];
  const names: string[] = [];
  for (const value of entries) {
    if (!value || typeof value !== "object")
      throw new Error("Invalid Cloudflare secret inventory entry.");
    const entry = value as Partial<SecretEntry>;
    if (typeof entry.name !== "string" || entry.type !== "secret_text") {
      throw new Error("Unexpected Cloudflare secret inventory entry; refusing operation.");
    }
    names.push(entry.name);
  }
  if (new Set(names).size !== names.length)
    throw new Error("Cloudflare returned duplicate secret names.");
  return names.sort();
}

function healthUrl(env: OperationsEnvironment): string {
  const raw = assertString(env.AIG_PUBLIC_URL, "AIG_PUBLIC_URL");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("AIG_PUBLIC_URL must be an absolute HTTPS address.");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw new Error("AIG_PUBLIC_URL must be an HTTPS origin without credentials or path.");
  }
  return `${url.origin}/health/ready`;
}

async function checkRuntimeHealth(url: string, fetcher: FetchFunction): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetcher(url, {
        method: "GET",
        signal: AbortSignal.timeout(15000),
      });
      if (response.ok) {
        const health: unknown = await response.json();
        if (health && typeof health === "object") {
          const result = health as Record<string, unknown>;
          if (result.ready === true && result.degraded !== true) return true;
        }
      }
    } catch {
      // Ignore response contents: service errors may expose private information.
    }
  }
  return false;
}

export async function putWorkerSecret(
  name: string,
  env: OperationsEnvironment,
  fetcher: FetchFunction = fetch
): Promise<void> {
  const worker = selectedWorker(env);
  const { accountId, token } = validateCommon(env);
  const secretValue = validateSecretMutation(name, env);
  // Private centers do not have a public readiness endpoint. Their runtime
  // readiness is checked later through the protected Gateway binding.
  const url = worker === "ai-gateway" ? healthUrl(env) : "";

  // Confirm the existing Worker can be queried before making any mutation.
  await listWorkerSecretNames(env, fetcher);
  const api = cloudflareUrl(accountId, worker);
  const updated = await requestCloudflare(fetcher, api, token, "PUT", {
    name,
    text: secretValue,
    type: "secret_text",
  });
  const result = updated.result as Record<string, unknown> | undefined;
  if (!result || result.name !== name || result.type !== "secret_text") {
    throw new Error("Cloudflare update result was not confirmed; secret state may have changed.");
  }

  const inventory = await listWorkerSecretNames(env, fetcher);
  if (!inventory.includes(name)) {
    throw new Error(
      "Updated secret is not present in Cloudflare inventory; state may have changed."
    );
  }
  if (worker === "ai-gateway" && !(await checkRuntimeHealth(url, fetcher))) {
    throw new Error(
      "Post-update runtime health failed. The secret may have changed; restore its previous value via a separately approved operation."
    );
  }
}

/** Remove only an explicitly approved retired Gateway Secret; never touch center Secrets. */
export async function deleteWorkerSecret(
  name: string,
  env: OperationsEnvironment,
  fetcher: FetchFunction = fetch
): Promise<void> {
  validateSecretDeletion(name, env);
  const { accountId, token } = validateCommon(env);
  const url = healthUrl(env);
  const before = await listWorkerSecretNames(env, fetcher);
  if (!before.includes(name)) {
    throw new Error("Secret is already absent; no Cloudflare deletion was performed.");
  }
  if (!(await checkRuntimeHealth(url, fetcher))) {
    throw new Error("Gateway runtime health must pass before deleting a retired Secret.");
  }
  await requestCloudflare(
    fetcher,
    `${cloudflareUrl(accountId, "ai-gateway")}/${encodeURIComponent(name)}`,
    token,
    "DELETE"
  );
  const after = await listWorkerSecretNames(env, fetcher);
  if (after.includes(name)) {
    throw new Error("Deleted Secret is still present; Cloudflare state must be inspected.");
  }
  if (!(await checkRuntimeHealth(url, fetcher))) {
    throw new Error(
      "Post-deletion Gateway health failed; Cloudflare state changed and requires recovery review."
    );
  }
}

export async function runOperations(
  operation: string,
  secretName: string,
  env: OperationsEnvironment,
  fetcher: FetchFunction = fetch
): Promise<string[]> {
  if (operation === "inventory") {
    if (secretName) throw new Error("inventory must not include a secret name.");
    return listWorkerSecretNames(env, fetcher);
  }
  if (operation === "put") {
    await putWorkerSecret(secretName, env, fetcher);
    return [];
  }
  if (operation === "delete") {
    await deleteWorkerSecret(secretName, env, fetcher);
    return [];
  }
  throw new Error("Unsupported AI Gateway operations action.");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const operation = process.argv[2] ?? "";
  const name = process.argv[3] ?? "";
  const env: OperationsEnvironment = { ...process.env };
  delete process.env.AIG_OPS_SECRET_VALUE;
  runOperations(operation, name, env)
    .then((names) => {
      if (operation === "inventory") {
        console.log("Cloudflare Worker Secret names (values are never read or printed):");
        for (const secretName of names) console.log(secretName);
        console.log("Inventory completed.");
      } else {
        const worker = selectedWorker(env);
        console.log(
          operation === "delete"
            ? "Approved retired Gateway Secret deleted; inventory and public health verified."
            : worker === "ai-gateway"
              ? "Gateway runtime Secret updated; inventory and public health verified. No Secret values logged."
              : "Private center Secret updated; inventory verified. Runtime readiness must be checked before Gateway cutover."
        );
      }
    })
    .catch((error: unknown) => {
      console.error(
        `::error::${error instanceof Error ? error.message : "AI Gateway operations failed."}`
      );
      process.exitCode = 1;
    });
}
