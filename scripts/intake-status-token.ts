import { githubEnvironment } from "./github-api.ts";
import { CliError, runCommand } from "./runtime-command.ts";

export function requireIntakeStatusToken(value: string | undefined): string {
  if (!value) {
    throw new CliError(
      "::error::Missing required secret AW_STATUS_TOKEN. In fongap-labs/action-worker open Settings → Secrets and variables → Actions and configure AW_STATUS_TOKEN with Commit statuses: Read and write on every managed repository. No token fallback is permitted.",
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
        `description=${description}`,
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
        `::error::AW_STATUS_TOKEN cannot create Commit Status in ${repository} (HTTP 403/404). Check Fine-grained PAT repository selection, organization approval, and Commit statuses: Read and write. Save it under fongap-labs/action-worker → Settings → Secrets and variables → Actions → AW_STATUS_TOKEN. Do not fall back to AW_CONTROL_TOKEN.`,
        77
      );
    }
    throw error;
  }
}
