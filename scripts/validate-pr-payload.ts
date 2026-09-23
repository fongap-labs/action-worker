import { isJsonRecord } from "./github-api.ts";
import {
  CliError,
  appendLines,
  handleError,
  isMain,
  parseJson,
} from "./runtime-command.ts";
import { validateRepositoryCapability } from "./repository-policy.ts";

const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const requestPattern = /^[A-Za-z0-9._:-]+$/;

export function validatePayload(value: unknown): void {
  if (!isJsonRecord(value)) {
    throw new CliError("::error::PR dispatch payload does not match contracts/pr-task.json.", 64);
  }
  const keys = Object.keys(value).sort();
  const expected = ["pr_number", "repository", "request_id", "schema_version"];
  const isValid = keys.length === expected.length
    && keys.every((key, index) => key === expected[index])
    && value.schema_version === "1"
    && typeof value.request_id === "string"
    && value.request_id.length >= 1
    && value.request_id.length <= 128
    && requestPattern.test(value.request_id)
    && typeof value.repository === "string"
    && repositoryPattern.test(value.repository)
    && typeof value.pr_number === "number"
    && Number.isInteger(value.pr_number)
    && value.pr_number >= 1;
  if (!isValid) {
    throw new CliError("::error::PR dispatch payload does not match contracts/pr-task.json.", 64);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 1) {
    throw new CliError("Usage: validate-pr-payload.ts <payload-json>", 64);
  }
  const value = parseJson(args[0] ?? "", "::error::PR dispatch payload does not match contracts/pr-task.json.", 64);
  validatePayload(value);
  const payload = value as Record<string, unknown>;
  const repositoryPolicy = process.env.AW_REPOSITORY_POLICY;
  if (!repositoryPolicy) {
    throw new CliError("::error::Missing Repository Variable: AW_REPOSITORY_POLICY.", 65);
  }
  validateRepositoryCapability(
    String(payload.repository),
    parseJson(repositoryPolicy, "::error::AW_REPOSITORY_POLICY must be valid JSON.", 65),
    "pr",
  );
  await appendLines(process.env.GITHUB_OUTPUT, [
    `repository=${String(payload.repository)}`,
    `pr_number=${String(payload.pr_number)}`,
    `request_id=${String(payload.request_id)}`,
  ]);
  console.log("PR dispatch payload validated.");
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
