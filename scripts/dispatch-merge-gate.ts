import {
  githubEnvironment,
  isJsonRecord,
  runGithubCli,
} from "./github-api.ts";
import {
  CliError,
  handleError,
  isMain,
  readJson,
  runText,
} from "./runtime-command.ts";

const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const shaPattern = /^[0-9a-f]{40}$/;
const workflowFile = "validate-central-merge.yml";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 4) {
    throw new CliError(
      "Usage: dispatch-merge-gate.ts <repository> <pr-number> <head-sha> <policy-file>",
      64,
    );
  }

  const [repository = "", prNumber = "", headSha = "", policyPath = ""] = args;
  if (!repositoryPattern.test(repository)) {
    throw new CliError("::error::Invalid merge-gate repository.", 64);
  }
  if (!/^\d+$/.test(prNumber) || Number(prNumber) < 1) {
    throw new CliError("::error::Invalid merge-gate PR number.", 64);
  }
  if (!shaPattern.test(headSha)) {
    throw new CliError("::error::Invalid merge-gate head SHA.", 64);
  }

  const policy = await readJson(policyPath);
  const ci = isJsonRecord(policy) && isJsonRecord(policy.ci) ? policy.ci : {};
  const repositories = Array.isArray(ci.merge_gate_repositories)
    ? ci.merge_gate_repositories.filter((item): item is string => typeof item === "string")
    : [];
  if (!repositories.includes(repository)) {
    console.log(`Repository merge gate dispatch skipped: ${repository}`);
    return;
  }

  const token = process.env.GH_TOKEN ?? "";
  if (!token) {
    throw new CliError("::error::Merge-gate control credential is unavailable.", 65);
  }

  const pr = JSON.parse(
    await runGithubCli(
      ["api", `repos/${repository}/pulls/${prNumber}`],
      token,
    ),
  ) as unknown;

  if (!isJsonRecord(pr) || !isJsonRecord(pr.head)) {
    throw new CliError("::error::Unable to resolve PR head for merge gate.", 65);
  }

  const resolvedSha = typeof pr.head.sha === "string" ? pr.head.sha : "";
  const headRef = typeof pr.head.ref === "string" ? pr.head.ref : "";
  const headRepository = isJsonRecord(pr.head.repo) && typeof pr.head.repo.full_name === "string"
    ? pr.head.repo.full_name
    : "";

  if (resolvedSha !== headSha) {
    throw new CliError("::error::Merge-gate request is stale; PR head changed.", 75);
  }
  if (headRepository !== repository) {
    throw new CliError("::error::Merge-gate workflow requires a same-repository PR branch.", 65);
  }
  if (!headRef || headRef.length > 255) {
    throw new CliError("::error::Invalid merge-gate PR branch.", 64);
  }

  const payload = JSON.stringify({
    ref: headRef,
    inputs: {
      head_sha: headSha,
    },
  });

  await runText(
    "gh",
    [
      "api",
      "--method",
      "POST",
      `repos/${repository}/actions/workflows/${workflowFile}/dispatches`,
      "--input",
      "-",
    ],
    {
      env: githubEnvironment(token),
      input: payload,
    },
  );

  console.log(`Repository merge gate dispatched: ${repository}#${prNumber} (${headRef})`);
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
