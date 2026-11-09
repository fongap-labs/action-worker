import { appendLines, CliError, handleError, isMain } from "./runtime-command.ts";

const names = [
  "CLOUDFLARE_ACCOUNT_ID_SECONDARY",
  "AIG_PUBLIC_URL",
  "AIG_AFFINITY_KV_ID",
  "AIG_USAGE_D1_ID",
  "AIG_ANALYTICS_DATASET",
] as const;

const outputs: Record<(typeof names)[number], string> = {
  CLOUDFLARE_ACCOUNT_ID_SECONDARY: "account_id",
  AIG_PUBLIC_URL: "public_url",
  AIG_AFFINITY_KV_ID: "affinity_kv_id",
  AIG_USAGE_D1_ID: "usage_d1_id",
  AIG_ANALYTICS_DATASET: "analytics_dataset",
};

/** Validates only non-sensitive deployment metadata owned by protected ai-gateway-ops. */
export function validateGatewayOpsVariables(
  input: Readonly<Record<string, string | undefined>>
): Record<string, string> {
  const result: Record<string, string> = {};
  const account = input.CLOUDFLARE_ACCOUNT_ID_SECONDARY ?? "";
  if (!/^[0-9a-f]{32}$/.test(account)) {
    throw new CliError("Approved ai-gateway-ops Account ID is unavailable or invalid.", 77);
  }
  result.CLOUDFLARE_ACCOUNT_ID_SECONDARY = account;

  const url = input.AIG_PUBLIC_URL ?? "";
  if (url) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new CliError("Approved ai-gateway-ops AIG_PUBLIC_URL is invalid.", 77);
    }
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash ||
      (url !== parsed.origin && url !== parsed.origin + "/")
    ) {
      throw new CliError("Approved ai-gateway-ops AIG_PUBLIC_URL must be an HTTPS origin.", 77);
    }
    result.AIG_PUBLIC_URL = parsed.origin;
  }

  const kv = input.AIG_AFFINITY_KV_ID ?? "";
  if (kv) {
    if (!/^[0-9a-f]{32}$/.test(kv)) {
      throw new CliError("Approved ai-gateway-ops affinity KV ID is invalid.", 77);
    }
    result.AIG_AFFINITY_KV_ID = kv;
  }

  const d1 = input.AIG_USAGE_D1_ID ?? "";
  if (d1) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(d1)) {
      throw new CliError("Approved ai-gateway-ops usage D1 ID is invalid.", 77);
    }
    result.AIG_USAGE_D1_ID = d1;
  }

  const dataset = input.AIG_ANALYTICS_DATASET ?? "";
  if (dataset) {
    if (!/^[A-Za-z0-9_]{1,64}$/.test(dataset)) {
      throw new CliError("Approved ai-gateway-ops analytics dataset name is invalid.", 77);
    }
    result.AIG_ANALYTICS_DATASET = dataset;
  }
  return result;
}

/** GitHub outputs contain identifiers/origins only, never Secrets or arbitrary ops values. */
async function main(): Promise<void> {
  if (
    process.env.GITHUB_ACTIONS !== "true" ||
    process.env.GITHUB_REPOSITORY !== "fongap-labs/action-worker" ||
    process.env.GITHUB_REF !== "refs/heads/main" ||
    !process.env.GITHUB_OUTPUT
  ) {
    throw new CliError("Gateway ops Variable export requires approved main-branch Actions.", 77);
  }
  const validated = validateGatewayOpsVariables(process.env);
  await appendLines(
    process.env.GITHUB_OUTPUT,
    names
      .filter((name) => validated[name] !== undefined)
      .map((name) => {
        return outputs[name] + "=" + validated[name];
      })
  );
  console.log("Protected AI Gateway ops Variable metadata validated; no secret values accessed.");
}

if (isMain(import.meta.url)) main().catch(handleError);
