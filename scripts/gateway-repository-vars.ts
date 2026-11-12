import { sign } from "node:crypto";
import { encodeGatewayOpsVariables } from "./gateway-ops-variables.ts";
import { appendLines, CliError, handleError, isMain } from "./runtime-command.ts";

// Fetch the repository's own Variables, not the GitHub Actions vars context.
// A job bound to ai-gateway-ops may inherit and shadow that context; the
// repository REST endpoint is the only authoritative source for this cutover.
export async function readGatewayRepositoryVariables(
  token: string,
  request: typeof fetch = fetch
): Promise<Record<string, string>> {
  if (!token) {
    throw new CliError("Repository Variable inventory requires a GitHub token.", 77);
  }
  const result: Record<string, string> = {};
  let isComplete = false;
  for (let page = 1; page <= 10; page++) {
    const response = await request(
      `https://api.github.com/repos/fongap-labs/action-worker/actions/variables?per_page=30&page=${page}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        signal: AbortSignal.timeout(15_000),
      }
    );
    if (!response.ok) {
      throw new CliError(
        `Repository Variable inventory denied or unavailable (HTTP ${response.status}).`,
        77
      );
    }
    const data = (await response.json()) as unknown;
    if (
      !data ||
      typeof data !== "object" ||
      !("variables" in data) ||
      !Array.isArray(data.variables)
    ) {
      throw new CliError("Repository Variable inventory response is invalid.", 77);
    }
    for (const item of data.variables) {
      if (
        !item ||
        typeof item !== "object" ||
        typeof item.name !== "string" ||
        typeof item.value !== "string"
      ) {
        throw new CliError("Repository Variable inventory entry is invalid.", 77);
      }
      if (Object.hasOwn(result, item.name)) {
        throw new CliError("Repository Variable inventory contains duplicated names.", 77);
      }
      result[item.name] = item.value;
    }
    if (data.variables.length < 30) {
      isComplete = true;
      break;
    }
  }
  if (!isComplete) {
    throw new CliError("Repository Variable inventory exceeds the supported page budget.", 77);
  }
  // This name has appeared in an unmasked Variables snapshot. Never allow
  // even a placeholder API-token value to be exported from Variables.
  for (const name of Object.keys(result)) {
    if (/^(?:AW_)?CLOUDFLARE_API_TOKEN(?:_|$)/.test(name)) {
      throw new CliError(
        "Cloudflare API Token must be a GitHub repository Secret, never a Variable.",
        77
      );
    }
  }
  return result;
}

const repository = "fongap-labs/action-worker";
const apiBase = "https://api.github.com";

function appJwt(clientId: string, privateKey: string, now: number): string {
  if (!clientId || !privateKey || /\s/.test(clientId)) {
    throw new CliError("Repository Variable inventory requires a configured GitHub App.", 77);
  }
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ iat: now - 60, exp: now + 540, iss: clientId })
  ).toString("base64url");
  const unsigned = `${header}.${payload}`;
  try {
    const signature = sign("RSA-SHA256", Buffer.from(unsigned), {
      key: privateKey.replaceAll("\\n", "\n"),
    }).toString("base64url");
    return `${unsigned}.${signature}`;
  } catch {
    throw new CliError("GitHub App signing key is invalid; refusing Variable access.", 77);
  }
}

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

/**
 * Mint a repository-restricted Variables:read installation token, consume it
 * inside this process, and revoke it before returning any deployment inputs.
 * No installation token is written to job outputs or shared across jobs.
 */
export async function readGatewayVariablesWithApp(
  clientId: string,
  privateKey: string,
  request: typeof fetch = fetch,
  now = Math.floor(Date.now() / 1000)
): Promise<Record<string, string>> {
  const jwt = appJwt(clientId, privateKey, now);
  const installationResponse = await request(`${apiBase}/repos/${repository}/installation`, {
    headers: authHeaders(jwt),
    signal: AbortSignal.timeout(15_000),
  });
  if (!installationResponse.ok) {
    throw new CliError("GitHub App installation for Action Worker could not be verified.", 77);
  }
  const installation = (await installationResponse.json()) as { id?: unknown };
  if (
    typeof installation.id !== "number" ||
    !Number.isSafeInteger(installation.id) ||
    installation.id <= 0
  ) {
    throw new CliError("GitHub App installation ID is invalid.", 77);
  }
  const minted = await request(`${apiBase}/app/installations/${installation.id}/access_tokens`, {
    method: "POST",
    headers: { ...authHeaders(jwt), "Content-Type": "application/json" },
    body: JSON.stringify({
      repositories: ["action-worker"],
      permissions: { actions_variables: "read" },
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!minted.ok) {
    throw new CliError(
      minted.status === 422 || minted.status === 403
        ? "GitHub App installation lacks repository Actions Variables: read; approve this permission in GitHub App settings before deploying."
        : `Unable to mint repository Variables read token (HTTP ${minted.status}).`,
      77
    );
  }
  const issued = (await minted.json()) as {
    token?: unknown;
    permissions?: Record<string, unknown>;
  };
  if (typeof issued.token !== "string" || issued.token.length < 10) {
    throw new CliError("GitHub App installation token response is invalid.", 77);
  }
  const token = issued.token;
  let snapshot: Record<string, string> | undefined;
  let readError: unknown;
  try {
    if (
      issued.permissions?.actions_variables !== "read" ||
      Object.keys(issued.permissions).some((key) => key !== "actions_variables" && key !== "metadata")
    ) {
      throw new CliError("GitHub App token has unexpected repository permissions.", 77);
    }
    snapshot = await readGatewayRepositoryVariables(token, request);
  } catch (error) {
    readError = error;
  }
  let isRevoked = false;
  try {
    const response = await request(`${apiBase}/installation/token`, {
      method: "DELETE",
      headers: authHeaders(token),
      signal: AbortSignal.timeout(15_000),
    });
    isRevoked = response.status === 204;
  } catch {
    // A token that cannot be revoked must never authorize deployment.
  }
  if (!isRevoked) {
    throw new CliError(
      "GitHub App Variables read token could not be revoked; deployment refused.",
      77
    );
  }
  if (readError !== undefined) throw readError;
  if (!snapshot) throw new CliError("Repository Variable inventory is unavailable.", 77);
  return snapshot;
}

async function main(): Promise<void> {
  if (
    process.env.GITHUB_ACTIONS !== "true" ||
    process.env.GITHUB_REPOSITORY !== "fongap-labs/action-worker" ||
    process.env.GITHUB_REF !== "refs/heads/main" ||
    !process.env.GITHUB_OUTPUT ||
    !process.env.AW_APP_CLIENT_ID ||
    !process.env.AW_APP_PRIVATE_KEY
  ) {
    throw new CliError("Repository Variable validation requires approved main-branch Actions.", 77);
  }
  const variables = await readGatewayVariablesWithApp(
    process.env.AW_APP_CLIENT_ID,
    process.env.AW_APP_PRIVATE_KEY
  );
  const encoded = encodeGatewayOpsVariables(variables);
  await appendLines(process.env.GITHUB_OUTPUT, [`variables_b64=${encoded}`]);
  console.log("Repository-scoped AI Gateway Variables validated; no values printed.");
}

if (isMain(import.meta.url)) main().catch(handleError);
