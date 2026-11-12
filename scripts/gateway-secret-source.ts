import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { appendLines, CliError, handleError, isMain } from "./runtime-command.ts";

const domain = "action-worker:gateway-cloudflare-repository-secret:v1";
const hex256 = /^[0-9a-f]{64}$/;

/**
 * A one-time HMAC proves the value seen without a GitHub Environment agrees
 * with the value seen by the protected deploy job. The token never crosses
 * jobs; only a per-run nonce and proof do.
 */
export function cloudflareRepositorySecretProof(secret: string, nonce: string): string {
  if (!secret) {
    throw new CliError("Required Action Worker Cloudflare Secret is unavailable.", 77);
  }
  if (!hex256.test(nonce)) {
    throw new CliError("Cloudflare repository Secret challenge is invalid.", 77);
  }
  return createHmac("sha256", secret).update(`${domain}:${nonce}`).digest("hex");
}

export function verifyGatewayCloudflareRepositorySecret(
  secret: string,
  nonce: string,
  proof: string
): void {
  if (!hex256.test(proof)) {
    throw new CliError("Cloudflare repository Secret proof is unavailable or invalid.", 77);
  }
  const expected = Buffer.from(cloudflareRepositorySecretProof(secret, nonce), "hex");
  const actual = Buffer.from(proof, "hex");
  if (!timingSafeEqual(expected, actual)) {
    throw new CliError(
      "Cloudflare Secret differs from the Action Worker repository scope. Remove the CLOUDFLARE_API_TOKEN_SECONDARY override from ai-gateway-ops before deploying.",
      77
    );
  }
}

async function main(): Promise<void> {
  if (
    process.env.GITHUB_ACTIONS !== "true" ||
    process.env.GITHUB_REPOSITORY !== "fongap-labs/action-worker" ||
    process.env.GITHUB_REF !== "refs/heads/main"
  ) {
    throw new CliError("Cloudflare Secret source verification requires approved main Actions.", 77);
  }
  const secret = process.env.CLOUDFLARE_API_TOKEN_SECONDARY ?? "";
  const mode = process.argv[2] ?? "";
  if (mode === "prove") {
    if (!process.env.GITHUB_OUTPUT) {
      throw new CliError("Cloudflare repository Secret proof output is unavailable.", 77);
    }
    const nonce = randomBytes(32).toString("hex");
    const proof = cloudflareRepositorySecretProof(secret, nonce);
    await appendLines(process.env.GITHUB_OUTPUT, [`nonce=${nonce}`, `proof=${proof}`]);
    console.log("Repository-scope Cloudflare Secret verified; no value exported.");
    return;
  }
  if (mode === "verify") {
    verifyGatewayCloudflareRepositorySecret(
      secret,
      process.env.AW_CLOUDFLARE_PROOF_NONCE ?? "",
      process.env.AW_CLOUDFLARE_REPOSITORY_PROOF ?? ""
    );
    console.log("Cloudflare deploy Secret matches the repository-scoped proof.");
    return;
  }
  throw new CliError("Expected Cloudflare Secret verification mode: prove or verify.", 64);
}

if (isMain(import.meta.url)) main().catch(handleError);
