import { getGithubJson, isJsonRecord } from "./github-api.ts";
import { appendLines, CliError, handleError, isMain } from "./runtime-command.ts";

const defaultReserve = 300;

export type GithubCoreBudgetDecision = {
  run: boolean;
  remaining: number;
  limit: number;
  reserve: number;
  reset_at: string;
};

export function parseGithubApiReserve(value: string): number {
  if (!/^[1-9]\d{0,4}$/.test(value)) {
    throw new CliError("GitHub API reserve must be an integer from 1 to 99999.", 64);
  }
  return Number(value);
}

/**
 * Only the installation's REST core budget is relevant to the intake scans.
 * Missing or malformed quota facts fail closed rather than reporting a safe deferral.
 */
export function evaluateGithubCoreBudget(
  value: unknown,
  reserve = defaultReserve
): GithubCoreBudgetDecision {
  if (!Number.isSafeInteger(reserve) || reserve < 1 || reserve > 99999) {
    throw new CliError("GitHub API reserve must be an integer from 1 to 99999.", 64);
  }
  const resources = isJsonRecord(value) ? value.resources : undefined;
  const core = isJsonRecord(resources) ? resources.core : undefined;
  if (
    !isJsonRecord(core) ||
    !Number.isSafeInteger(core.remaining) ||
    !Number.isSafeInteger(core.limit) ||
    !Number.isSafeInteger(core.reset) ||
    (core.remaining as number) < 0 ||
    (core.limit as number) < 1 ||
    (core.remaining as number) > (core.limit as number) ||
    (core.reset as number) < 1
  ) {
    throw new CliError("GitHub App REST core API quota response is invalid.", 65);
  }
  const remaining = core.remaining as number;
  const limit = core.limit as number;
  const reset_at = new Date((core.reset as number) * 1000).toISOString();
  return { run: remaining > reserve, remaining, limit, reserve, reset_at };
}

async function main(): Promise<void> {
  const token = process.env.AW_CONTROL_TOKEN ?? "";
  if (!token) {
    throw new CliError("AW_CONTROL_TOKEN is required for the API quota preflight.", 77);
  }
  const reserve = parseGithubApiReserve(process.env.AW_API_QUOTA_RESERVE ?? String(defaultReserve));
  // GitHub's rate_limit endpoint does not consume the primary REST core quota.
  const decision = evaluateGithubCoreBudget(await getGithubJson("rate_limit", token), reserve);
  await appendLines(process.env.GITHUB_OUTPUT, [`run=${decision.run}`]);
  console.log(
    `GitHub App REST core remaining=${decision.remaining}/${decision.limit}; reserve=${reserve}; reset=${decision.reset_at}.`
  );
  if (!decision.run) {
    const notice =
      `Optional intake scan deferred to preserve GitHub App REST core quota: ` +
      `remaining=${decision.remaining}, reserve=${reserve}, reset=${decision.reset_at}.`;
    console.log(`::warning::${notice}`);
    await appendLines(process.env.GITHUB_STEP_SUMMARY, [
      `### API 配额保护：本轮可延后扫描未执行`,
      `剩余额度 ${decision.remaining}/${decision.limit}，保留阈值 ${reserve}，重置时间 ${decision.reset_at}。`,
      "主分支 CI、PR 治理及主分支写入审计不受此预检影响。",
    ]);
  }
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
