import { githubEnvironment } from "./github-api.ts";
import { CliError, handleError, isMain, runText } from "./runtime-command.ts";

const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const requestPattern = /^[A-Za-z0-9._:-]{1,128}$/;
const shaPattern = /^[0-9a-f]{40}$/;

export function buildReviewDispatch(
  repository: string,
  prNumber: string,
  requestId: string,
  headSha: string
): string {
  if (!repositoryPattern.test(repository)) {
    throw new CliError("::error::Invalid review repository.", 64);
  }
  if (!/^[1-9][0-9]*$/.test(prNumber)) {
    throw new CliError("::error::Invalid review PR number.", 64);
  }
  if (!requestPattern.test(requestId)) {
    throw new CliError("::error::Invalid review request id.", 64);
  }
  if (!shaPattern.test(headSha)) {
    throw new CliError("::error::Invalid review head SHA.", 64);
  }
  return JSON.stringify({
    event_type: "run-pr-review",
    client_payload: {
      schema_version: "1",
      request_id: requestId,
      repository,
      pr_number: Number(prNumber),
      head_sha: headSha,
    },
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 4) {
    throw new CliError(
      "Usage: dispatch-pr-review.ts <repository> <pr-number> <request-id> <head-sha>",
      64
    );
  }
  const [repository = "", prNumber = "", requestId = "", headSha = ""] = args;
  const payload = buildReviewDispatch(repository, prNumber, requestId, headSha);
  const token = process.env.GH_TOKEN ?? "";
  const controlRepository = process.env.GITHUB_REPOSITORY ?? "";
  if (!token || !repositoryPattern.test(controlRepository)) {
    throw new CliError("::error::PR review dispatch credentials are unavailable.", 65);
  }
  await runText(
    "gh",
    ["api", "--method", "POST", `repos/${controlRepository}/dispatches`, "--input", "-"],
    {
      env: githubEnvironment(token),
      input: payload,
    }
  );
  console.log(`AI Review dispatched: ${repository}#${prNumber}@${headSha}`);
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
