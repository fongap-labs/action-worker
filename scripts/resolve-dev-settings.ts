import type { JsonReader } from "./ci-evidence.ts";
import {
  getGithubJsonIfExists,
  getJsonString,
  isJsonRecord,
  statusAwareReader,
} from "./github-api.ts";
import { readRepositoryPolicyText, repositoriesForCapability } from "./repository-policy.ts";
import { appendLines, CliError, handleError, isMain } from "./runtime-command.ts";
import { latestAttestedStatus } from "./status-attestation.ts";

/** Audit results select targets only; actual settings still require live enrollment proof. */
export async function resolveDevSettings(
  reader: JsonReader,
  policy: unknown,
  controlRepository: string,
  runId: number
): Promise<string[]> {
  if (!Number.isSafeInteger(runId) || runId < 1) {
    throw new CliError("Invalid dev audit run identity.", 65);
  }
  const run = await reader.get(`repos/${controlRepository}/actions/runs/${runId}`);
  if (
    !isJsonRecord(run) ||
    run.id !== runId ||
    getJsonString(run.repository, "full_name") !== controlRepository ||
    getJsonString(run, "path") !== ".github/workflows/intake.yml" ||
    run.head_branch !== "main" ||
    run.status !== "completed" ||
    run.conclusion !== "success"
  ) {
    throw new CliError("Dev settings continuation requires the trusted completed intake.", 75);
  }
  const target = `https://github.com/${controlRepository}/actions/runs/${runId}`;
  const repositories = repositoriesForCapability(policy, "pr");
  const changed: string[] = [];
  for (const repository of repositories) {
    if (repository === controlRepository) continue;
    const prefix = `repos/${repository}`;
    const branch = await getGithubJsonIfExists(`${prefix}/branches/dev`, (path) =>
      reader.get(path)
    );
    if (branch === undefined) continue;
    const sha = isJsonRecord(branch) ? getJsonString(branch.commit, "sha") : "";
    if (!/^[0-9a-f]{40}$/.test(sha)) {
      throw new CliError("Invalid development branch identity.", 75);
    }
    const statuses = await reader.get(`${prefix}/commits/${sha}/status`);
    const guard = latestAttestedStatus(statuses, {
      repository,
      sha,
      context: "Dev Write Guard",
    });
    if (getJsonString(guard, "target_url") === target) changed.push(repository);
  }
  return changed;
}

async function main(): Promise<void> {
  const token = process.env.AW_CONTROL_TOKEN ?? "";
  const controlRepository = process.env.GITHUB_REPOSITORY ?? "";
  if (!token || !controlRepository || process.env.GITHUB_REF !== "refs/heads/main") {
    throw new CliError("Trusted main and scoped read token required.", 77);
  }
  const repositories = await resolveDevSettings(
    statusAwareReader(process.env.GITHUB_API_URL ?? "https://api.github.com", token, token),
    JSON.parse(readRepositoryPolicyText()),
    controlRepository,
    Number(process.env.AUDIT_RUN_ID)
  );
  await appendLines(process.env.GITHUB_OUTPUT, [`repositories=${JSON.stringify(repositories)}`]);
  console.log(`Dev audit continuation selected ${repositories.length} repositories.`);
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
