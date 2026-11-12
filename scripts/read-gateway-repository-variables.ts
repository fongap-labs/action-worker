import { encodeGatewayOpsVariables } from "./gateway-ops-variables.ts";
import { appendLines, CliError, handleError, isMain } from "./runtime-command.ts";

// Fetch the repository's own Variables, not the GitHub Actions vars context.
// A job bound to ai-gateway-ops may inherit and shadow that context; the
// repository REST endpoint is the only authoritative source for this cutover.
export async function readGatewayRepositoryVariables(
  token: string,
  request: typeof fetch = fetch
): Promise<Record<string, string>> {
  if (!token) throw new CliError("Repository Variable inventory requires a GitHub token.", 77);
  const result: Record<string, string> = {};
  let completed = false;
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
      throw new CliError(`Repository Variable inventory denied or unavailable (HTTP ${response.status}).`, 77);
    }
    const data = (await response.json()) as unknown;
    if (!data || typeof data !== "object" || !("variables" in data) || !Array.isArray(data.variables)) {
      throw new CliError("Repository Variable inventory response is invalid.", 77);
    }
    for (const item of data.variables) {
      if (!item || typeof item !== "object" || typeof item.name !== "string" || typeof item.value !== "string") {
        throw new CliError("Repository Variable inventory entry is invalid.", 77);
      }
      if (Object.hasOwn(result, item.name)) {
        throw new CliError("Repository Variable inventory contains duplicated names.", 77);
      }
      result[item.name] = item.value;
    }
    if (data.variables.length < 30) {
      completed = true;
      break;
    }
  }
  if (!completed) throw new CliError("Repository Variable inventory exceeds the supported page budget.", 77);
  // This name has appeared in an unmasked Variables snapshot. Never allow
  // even a placeholder API-token value to be exported from Variables.
  for (const name of Object.keys(result)) {
    if (/^(?:AW_)?CLOUDFLARE_API_TOKEN(?:_|$)/.test(name)) {
      throw new CliError("Cloudflare API Token must be a GitHub repository Secret, never a Variable.", 77);
    }
  }
  return result;
}

async function main(): Promise<void> {
  if (
    process.env.GITHUB_ACTIONS !== "true" ||
    process.env.GITHUB_REPOSITORY !== "fongap-labs/action-worker" ||
    process.env.GITHUB_REF !== "refs/heads/main" ||
    !process.env.GITHUB_OUTPUT
  ) {
    throw new CliError("Repository Variable validation requires approved main-branch Actions.", 77);
  }
  const variables = await readGatewayRepositoryVariables(process.env.GITHUB_TOKEN ?? "");
  const encoded = encodeGatewayOpsVariables(variables);
  await appendLines(process.env.GITHUB_OUTPUT, [`variables_b64=${encoded}`]);
  console.log("Repository-scoped AI Gateway Variables validated; no values printed.");
}

if (isMain(import.meta.url)) main().catch(handleError);
