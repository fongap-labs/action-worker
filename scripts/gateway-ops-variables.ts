import { isJsonRecord } from "./github-api.ts";
import { appendLines, CliError, handleError, isMain, parseJson } from "./runtime-command.ts";

const accountName = "CLOUDFLARE_ACCOUNT_ID_SECONDARY";
const maximumVariableBytes = 4_500;
const maximumSnapshotBytes = 256 * 1024;
const gatewayVariableName = /^AIG_[A-Z0-9_]+$/;
const nodeShardName = /^AIG_TIER[12]_NODES_(?:0[1-9]|10)$/;
const accessModelsName = /^AIG_ACCESS_MODELS_[A-Z][A-Z0-9_]*$/;
const serviceName = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const derivedNames = new Set([
  "AIG_BUILD_SHA",
  "AIG_INFERENCE_ACTIVE",
  "AIG_GENERATION_ACTIVE",
  "AIG_INFERENCE_SERVICE",
  "AIG_GENERATION_SERVICE",
]);

const forbiddenSecretNamePattern =
  /(?:^|_)(?:SECRET|SECRETS|TOKEN|TOKENS|KEY|KEYS|CREDENTIAL|CREDENTIALS)(?:_|$)/;

const forbiddenSecretNames = [
  /^CLOUDFLARE_API_TOKEN(?:_|$)/,
  /^AIG_ACCESS_KEY(?:_|$)/,
  /^AIG_TIER[12]_CREDENTIALS(?:_|$)/,
  /^AIG_(?:INFERENCE|GENERATION)_AUTH_KEY$/,
  /^AIG_DEPLOY_HEALTH_KEY$/,
  /^AIG_EDGE_CACHE_HMAC_KEY$/,
  /^AIG_OPS_SECRET_VALUE$/,
  /^AIG_TOKEN_ENCRYPTION_KEY$/,
];

/** Names whose non-sensitive values are owned only by protected ai-gateway-ops. */
export function isGatewayOwnedVariableName(name: string): boolean {
  return name === accountName || gatewayVariableName.test(name);
}

function fail(name: string, reason: string): never {
  throw new CliError(`Approved ai-gateway-ops Variable ${name} ${reason}.`, 77);
}

/**
 * Validates the complete non-sensitive AI Gateway deployment Variable snapshot.
 * Model identifiers and policy values remain data; this layer never hardcodes them.
 */
export function validateGatewayOpsVariables(
  input: Readonly<Record<string, unknown>>
): Record<string, string> {
  const result: Record<string, string> = {};

  for (const name of Object.keys(input).sort()) {
    if (
      forbiddenSecretNames.some((pattern) => pattern.test(name)) ||
      (name.startsWith("AIG_") && forbiddenSecretNamePattern.test(name))
    ) {
      fail(name, "must be stored as a Secret, not a Variable");
    }
    if (!isGatewayOwnedVariableName(name)) continue;
    if (/TIER3|OAUTH|SUBSCRIPTION/.test(name)) {
      fail(name, "belongs to a retired Tier 3, OAuth, or subscription contract");
    }
    if (derivedNames.has(name)) {
      fail(name, "is derived during deployment and cannot be configured");
    }
    if (/^AIG_TIER[12]_NODES_/.test(name) && !nodeShardName.test(name)) {
      fail(name, "must use a Tier 1 or Tier 2 node shard suffix from 01 through 10");
    }
    if (/^AIG_ACCESS_MODELS_/.test(name) && !accessModelsName.test(name)) {
      fail(name, "has an invalid access-model group suffix");
    }

    const value = input[name];
    if (typeof value !== "string") fail(name, "must be a string");
    if (Buffer.byteLength(value, "utf8") > maximumVariableBytes) {
      fail(name, `exceeds ${maximumVariableBytes} UTF-8 bytes`);
    }
    result[name] = value;
  }

  const account = result[accountName] ?? "";
  if (!/^[0-9a-f]{32}$/.test(account)) {
    fail(accountName, "is unavailable or invalid");
  }

  const publicUrl = result.AIG_PUBLIC_URL;
  if (publicUrl) {
    let parsed: URL;
    try {
      parsed = new URL(publicUrl);
    } catch {
      fail("AIG_PUBLIC_URL", "is invalid");
    }
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash ||
      (publicUrl !== parsed.origin && publicUrl !== `${parsed.origin}/`)
    ) {
      fail("AIG_PUBLIC_URL", "must be an HTTPS origin");
    }
    result.AIG_PUBLIC_URL = parsed.origin;
  }

  const kv = result.AIG_AFFINITY_KV_ID;
  if (kv && !/^[0-9a-f]{32}$/.test(kv)) fail("AIG_AFFINITY_KV_ID", "is invalid");

  const d1 = result.AIG_USAGE_D1_ID;
  if (d1 && !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(d1)) {
    fail("AIG_USAGE_D1_ID", "is invalid");
  }

  const dataset = result.AIG_ANALYTICS_DATASET;
  if (dataset && !/^[A-Za-z0-9_]{1,64}$/.test(dataset)) {
    fail("AIG_ANALYTICS_DATASET", "is invalid");
  }

  for (const name of ["AIG_INFERENCE_TARGET", "AIG_GENERATION_TARGET"] as const) {
    const value = result[name];
    if (value && !serviceName.test(value)) fail(name, "is not a valid Worker service name");
  }

  const serializedBytes = Buffer.byteLength(JSON.stringify(result), "utf8");
  if (serializedBytes > maximumSnapshotBytes) {
    throw new CliError(
      `Approved ai-gateway-ops Variable snapshot exceeds ${maximumSnapshotBytes} UTF-8 bytes.`,
      77
    );
  }
  return result;
}

/** Bootstrap needs two explicit metadata values; inherited vars must not become ops inventory. */
export function validateGatewayBootstrapMetadata(
  input: Readonly<Record<string, unknown>>
): Record<string, string> {
  return validateGatewayOpsVariables({
    CLOUDFLARE_ACCOUNT_ID_SECONDARY: input.CLOUDFLARE_ACCOUNT_ID_SECONDARY,
    AIG_PUBLIC_URL: input.AIG_PUBLIC_URL ?? "",
  });
}

export function encodeGatewayOpsVariables(input: Readonly<Record<string, unknown>>): string {
  const validated = validateGatewayOpsVariables(input);
  return Buffer.from(JSON.stringify(validated), "utf8").toString("base64url");
}

export function decodeGatewayOpsVariables(encoded: string): Record<string, string> {
  if (!encoded || encoded.length > Math.ceil((maximumSnapshotBytes * 4) / 3) + 4) {
    throw new CliError(
      "Approved ai-gateway-ops Variable snapshot is unavailable or too large.",
      77
    );
  }
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw new CliError("Approved ai-gateway-ops Variable snapshot encoding is invalid.", 77);
  }
  const decoded = Buffer.from(encoded, "base64url").toString("utf8");
  const parsed = parseJson(decoded, "Approved ai-gateway-ops Variable snapshot is invalid.", 77);
  if (!isJsonRecord(parsed)) {
    throw new CliError("Approved ai-gateway-ops Variable snapshot must be a JSON object.", 77);
  }
  return validateGatewayOpsVariables(parsed);
}

/** GitHub output contains validated non-sensitive Variables only, never Secrets. */
async function main(): Promise<void> {
  if (
    process.env.GITHUB_ACTIONS !== "true" ||
    process.env.GITHUB_REPOSITORY !== "fongap-labs/action-worker" ||
    process.env.GITHUB_REF !== "refs/heads/main" ||
    !process.env.GITHUB_OUTPUT
  ) {
    throw new CliError("Gateway ops Variable export requires approved main-branch Actions.", 77);
  }
  const bootstrapMetadataOnly = process.env.AIG_BOOTSTRAP_METADATA_ONLY === "true";
  let validated: Record<string, string>;
  if (bootstrapMetadataOnly) {
    // The workflow passes exact names, not toJSON(vars), which includes inherited bindings.
    if (process.env.AIG_OPS_VARIABLES_JSON) {
      throw new CliError("Bootstrap metadata must not include the inherited Variables snapshot.", 77);
    }
    validated = validateGatewayBootstrapMetadata(process.env);
  } else {
    const payload = parseJson(
      process.env.AIG_OPS_VARIABLES_JSON || "{}",
      "Approved ai-gateway-ops Variables payload must be valid JSON.",
      77
    );
    if (!isJsonRecord(payload)) {
      throw new CliError("Approved ai-gateway-ops Variables payload must be a JSON object.", 77);
    }
    validated = validateGatewayOpsVariables(payload);
  }
  await appendLines(process.env.GITHUB_OUTPUT, [
    `variables_b64=${Buffer.from(JSON.stringify(validated), "utf8").toString("base64url")}`,
    `account_id=${validated.CLOUDFLARE_ACCOUNT_ID_SECONDARY}`,
    `public_url=${validated.AIG_PUBLIC_URL ?? ""}`,
  ]);
  console.log(`Protected AI Gateway ops Variables validated: ${Object.keys(validated).length}.`);
}

if (isMain(import.meta.url)) main().catch(handleError);
