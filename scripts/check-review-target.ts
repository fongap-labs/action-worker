import { trustedCiStatus } from "./ci-evidence.ts";
import { getGithubJson, getJsonString, isJsonRecord } from "./github-api.ts";
import { appendLines, CliError, handleError, isMain } from "./runtime-command.ts";

const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const shaPattern = /^[0-9a-f]{40}$/;
const governanceContext = "PR Governance";

export type ReviewTarget = { current: boolean; reason: string };

// AI Review may only run for the exact head that already passed the deterministic gate. The
// caller's claim is never trusted: the pull request head and the gate status are read again.
export function evaluateReviewTarget(
  pull: unknown,
  status: unknown,
  requestedHeadSha: string,
  controlRepository: string
): ReviewTarget {
  if (!isJsonRecord(pull) || pull.state !== "open") {
    return { current: false, reason: "the pull request is no longer open" };
  }
  const head = isJsonRecord(pull.head) ? pull.head : {};
  if (getJsonString(head, "sha") !== requestedHeadSha) {
    return { current: false, reason: "the pull request head changed after the gate passed" };
  }
  const governance = trustedCiStatus(status, governanceContext, controlRepository);
  if (getJsonString(governance, "state") !== "success") {
    return {
      current: false,
      reason: `${governanceContext} is not a trusted success for this head`,
    };
  }
  return { current: true, reason: "the gate passed for the current pull request head" };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 3) {
    throw new CliError("Usage: check-review-target.ts <repository> <pr-number> <head-sha>", 64);
  }
  const [repository = "", prNumber = "", headSha = ""] = args;
  if (!repositoryPattern.test(repository)) {
    throw new CliError(`::error::Invalid repository: ${repository}.`, 64);
  }
  if (!/^[1-9][0-9]*$/.test(prNumber)) {
    throw new CliError(`::error::Invalid PR number: ${prNumber}.`, 64);
  }
  if (!shaPattern.test(headSha)) {
    throw new CliError("::error::Invalid review head SHA.", 64);
  }
  const token = process.env.GH_TOKEN ?? "";
  const controlRepository = process.env.GITHUB_REPOSITORY ?? "";
  if (!token || !repositoryPattern.test(controlRepository)) {
    throw new CliError("::error::Review target authority is unavailable.", 65);
  }
  const pull = await getGithubJson(`repos/${repository}/pulls/${prNumber}`, token);
  const status = await getGithubJson(`repos/${repository}/commits/${headSha}/status`, token);
  const target = evaluateReviewTarget(pull, status, headSha, controlRepository);
  await appendLines(process.env.GITHUB_OUTPUT, [`current=${target.current}`]);
  console.log(
    target.current
      ? `Review target confirmed: ${repository}#${prNumber}@${headSha}`
      : `::notice::AI Review skipped for ${repository}#${prNumber}@${headSha}: ${target.reason}.`
  );
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
