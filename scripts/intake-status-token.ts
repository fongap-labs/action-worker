import { githubEnvironment } from "./github-api.ts";
import { CliError, runCommand } from "./runtime-command.ts";
import { signedStatusDescription } from "./status-attestation.ts";

export function requireIntakeStatusToken(value: string | undefined): string {
  if (!value) {
    throw new CliError(
      "::error::Missing required AW_STATUS_API_TOKEN. Mint a repository-scoped GitHub App token with Commit statuses write in the calling workflow. No token fallback is permitted.",
      77
    );
  }
  return value;
}

export async function reserveIntakeCommitStatus(
  token: string,
  repository: string,
  headSha: string,
  context: string,
  description: string,
  targetUrl: string
): Promise<void> {
  const signedDescription = signedStatusDescription({
    repository,
    sha: headSha,
    state: "pending",
    context,
    description,
    targetUrl,
  });
  try {
    await runCommand(
      "gh",
      [
        "api",
        "--method",
        "POST",
        `repos/${repository}/statuses/${headSha}`,
        "-f",
        "state=pending",
        "-f",
        `context=${context}`,
        "-f",
        `description=${signedDescription}`,
        "-f",
        `target_url=${targetUrl}`,
      ],
      {
        env: githubEnvironment(requireIntakeStatusToken(token)),
        timeoutMs: 30_000,
        maxBuffer: 1024 * 1024,
      }
    );
  } catch (error) {
    if (error instanceof CliError && /HTTP (?:403|404)\b/.test(error.message)) {
      throw new CliError(
        `::error::The scoped GitHub App token cannot create Commit Status in ${repository} (HTTP 403/404). Confirm the App installation includes this repository and Commit statuses: Write.`,
        77
      );
    }
    throw error;
  }
}
