import { appendLines, CliError, handleError, isMain } from "./runtime-command.ts";

const owner = "fongap-labs/internal-vault";
const approvedProjects = new Set(["EngineSuite", "FongapBlog", "FongapCDN", "MarketChina", "MarketGlobal"]);
const variableName = "CLOUDFLARE_ACCOUNT_ID_PRIMARY";

/** This path moves one non-sensitive identifier, never task Secrets or arbitrary ops Variables. */
export function approvedTaskOpsAccountId(
  repository: string,
  project: string,
  fromOps: string | undefined,
  fromJob: string | undefined
): string | null {
  if (!fromOps) return null;
  if (repository !== owner || !approvedProjects.has(project)) {
    throw new CliError("Task ops Variable handoff is not authorized for this source.", 77);
  }
  if (!/^[0-9a-f]{32}$/.test(fromOps)) {
    throw new CliError("Approved task ops Account ID is unavailable or invalid.", 77);
  }
  if (fromJob && fromJob !== fromOps) {
    throw new CliError("Task Account ID has conflicting Variable sources.", 77);
  }
  return fromOps;
}

async function main(): Promise<void> {
  if (
    process.env.GITHUB_ACTIONS !== "true" ||
    process.env.GITHUB_REPOSITORY !== "fongap-labs/action-worker" ||
    process.env.GITHUB_REF !== "refs/heads/main"
  ) {
    throw new CliError("Task ops Variable handoff requires approved main-branch Actions.", 77);
  }
  const mode = process.argv[2] ?? "";
  const repository = process.env.TASK_SOURCE_REPOSITORY ?? "";
  const project = process.env.PROJECT ?? "";
  const fromOps =
    mode === "export"
      ? process.env.CLOUDFLARE_ACCOUNT_ID_PRIMARY
      : process.env.AW_TASK_ACCOUNT_ID_FROM_OPS;
  const fromJob = mode === "import" ? process.env.CLOUDFLARE_ACCOUNT_ID_PRIMARY : undefined;
  if (mode !== "export" && mode !== "import") {
    throw new CliError("Task ops Variable handoff mode is invalid.", 64);
  }
  const value = approvedTaskOpsAccountId(repository, project, fromOps, fromJob);
  if (mode === "export" && !value) {
    throw new CliError("Approved task ops Account ID is unavailable.", 77);
  }
  if (mode === "export") {
    if (!process.env.GITHUB_OUTPUT) throw new CliError("Missing trusted Actions output.", 77);
    await appendLines(process.env.GITHUB_OUTPUT, ["account_id=" + value]);
  } else if (value) {
    if (!process.env.GITHUB_ENV) throw new CliError("Missing trusted Actions environment.", 77);
    await appendLines(process.env.GITHUB_ENV, [variableName + "=" + value]);
  }
  console.log("Approved task ops account metadata validated; no Secret or account value logged.");
}

if (isMain(import.meta.url)) main().catch(handleError);
