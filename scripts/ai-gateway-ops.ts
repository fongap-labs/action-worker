import { fileURLToPath } from "node:url";

const workerName = "ai-gateway";
const secretNamePattern =
  /^(?:AIG_DEPLOY_HEALTH_KEY|AIG_TOKEN_ENCRYPTION_KEY|AIG_(?:INFERENCE|GENERATION)_AUTH_KEY|AIG_ACCESS_KEY_(?:AIR|PRO|MAX|ULTRA|AGENT)|AIG_TIER[123]_CREDENTIALS_(?:0[1-9]|10))$/;
const healthKeyPattern = /^[A-Za-z0-9_-]{32,}$/;
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
  if (!secretNamePattern.test(name))
    throw new Error("Requested secret is outside the AI Gateway runtime allowlist.");
  const secretValue = assertString(env.AIG_OPS_SECRET_VALUE, "AIG_OPS_SECRET_VALUE");
  if (Buffer.byteLength(secretValue, "utf8") > maxSecretBytes) {
    throw new Error("Secret exceeds the Worker secret size limit; split credential shards first.");
  }
  if (name === "AIG_DEPLOY_HEALTH_KEY" && !healthKeyPattern.test(secretValue)) {
    throw new Error("AIG_DEPLOY_HEALTH_KEY must have at least 32 URL-safe characters.");
  }
  if (
    (name === "AIG_INFERENCE_AUTH_KEY" || name === "AIG_GENERATION_AUTH_KEY") &&
    secretValue.length < 32
  ) {
    throw new Error("Center authentication secret must contain at least 32 characters.");
  }
  if (name.startsWith("AIG_ACCESS_KEY_") && secretValue === env.AIG_DEPLOY_HEALTH_KEY) {
    throw new Error("Application access key must not reuse the deployment health credential.");
  }
  return secretValue;
}

function cloudflareUrl(accountId: string): string {
  return `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${workerName}/secrets`;
}

async function requestCloudflare(
  fetcher: FetchFunction,
  url: string,
  token: string,
  method: "GET" | "PUT",
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
    throw new Error(`Cloudflare API refused the request (HTTP ${response.status}); no token fallback is allowed.`);
  }
  return payload as Record<string, unknown>;
}

export async function listWorkerSecretNames(
  env: OperationsEnvironment,
  fetcher: FetchFunction = fetch
): Promise<string[]> {
  const { accountId, token } = validateCommon(env);
  const data = await requestCloudflare(fetcher, cloudflareUrl(accountId), token, "GET");
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
  return `${url.origin}/health`;
}

async function checkRuntimeHealth(
  url: string,
  key: string,
  fetcher: FetchFunction
): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetcher(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(15000),
      });
      if (response.ok) {
        const health: unknown = await response.json();
        if (health && typeof health === "object") {
          const result = health as Record<string, unknown>;
          if (
            result.ready === true &&
            typeof result.nodes_total === "number" &&
            result.nodes_total > 0 &&
            result.nodes_usable === result.nodes_total
          )
            return true;
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
  const { accountId, token } = validateCommon(env);
  const secretValue = validateSecretMutation(name, env);
  const url = healthUrl(env);
  const healthKey =
    name === "AIG_DEPLOY_HEALTH_KEY"
      ? secretValue
      : assertString(env.AIG_DEPLOY_HEALTH_KEY, "AIG_DEPLOY_HEALTH_KEY");
  if (!healthKeyPattern.test(healthKey)) {
    throw new Error("AIG_DEPLOY_HEALTH_KEY must be an independent URL-safe credential.");
  }

  // Confirm the existing Worker can be queried before making any mutation.
  await listWorkerSecretNames(env, fetcher);
  const api = cloudflareUrl(accountId);
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
  if (!(await checkRuntimeHealth(url, healthKey, fetcher))) {
    throw new Error(
      "Post-update runtime health failed. The secret may have changed; restore its previous value via a separately approved operation."
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
  throw new Error("Unsupported AI Gateway operations action.");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const operation = process.argv[2] ?? "";
  const name = process.argv[3] ?? "";
  const env: OperationsEnvironment = { ...process.env };
  delete process.env.AIG_OPS_SECRET_VALUE;
  runOperations(operation, name, env).then((names) => {
    if (operation === "inventory") {
      console.log("Cloudflare Worker Secret names (values are never read or printed):");
      for (const secretName of names) console.log(secretName);
      console.log("Inventory completed.");
    } else {
      console.log("AI Gateway runtime secret updated; name and health checks passed. No secret values were logged.");
    }
  }).catch((error: unknown) => {
    console.error(`::error::${error instanceof Error ? error.message : "AI Gateway operations failed."}`);
    process.exitCode = 1;
  });
}
