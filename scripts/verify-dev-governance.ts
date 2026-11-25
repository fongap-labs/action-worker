import { hasVerifiedCiEvidence, type JsonReader } from "./ci-evidence.ts";
import { devGovernanceReceipt, prCiScopeDescription, readCurrentPrCiScope } from "./ci-scope-receipt.ts";
import { requireToken } from "./control-token.ts";
import { getJsonString, isJsonRecord, statusAwareReader } from "./github-api.ts";
import { prTitleFingerprint } from "./pr-title-fingerprint.ts";
import { appendLines, CliError, handleError, isMain } from "./runtime-command.ts";

export async function verifyDevGovernance(
  reader: JsonReader,
  repository: string,
  prNumber: number,
  headSha: string,
  baseSha: string,
  titleFingerprint: string,
  controlRepository: string
): Promise<string> {
  const scope = await readCurrentPrCiScope(reader, repository, prNumber, headSha, "dev");
  if (!scope || scope.baseSha !== baseSha) {
    throw new CliError("Dev governance base or merge snapshot changed.", 75);
  }
  const pull = await reader.get(`repos/${repository}/pulls/${prNumber}`);
  if (
    !isJsonRecord(pull) ||
    !isJsonRecord(pull.base) ||
    !isJsonRecord(pull.base.repo) ||
    pull.base.repo.private !== false ||
    prTitleFingerprint(getJsonString(pull, "title").replace(/[\r\n]/g, " ")) !== titleFingerprint
  ) {
    throw new CliError("Dev governance repository or title changed.", 75);
  }
  const status = await reader.get(`repos/${repository}/commits/${headSha}/status`);
  if (
    !(await hasVerifiedCiEvidence(reader, status, {
      controlRepository,
      targetRepository: repository,
      targetSha: headSha,
      expectedPrScope: scope,
    }))
  ) {
    throw new CliError("Dev governance lacks matching signed CI evidence.", 75);
  }
  const current = await readCurrentPrCiScope(reader, repository, prNumber, headSha, "dev");
  if (!current || prCiScopeDescription(current) !== prCiScopeDescription(scope)) {
    throw new CliError("Dev governance scope changed during verification.", 75);
  }
  return devGovernanceReceipt(scope, titleFingerprint);
}

async function main(): Promise<void> {
  const receipt = await verifyDevGovernance(
    statusAwareReader(
      process.env.GITHUB_API_URL ?? "https://api.github.com",
      requireToken("control"),
      requireToken("status")
    ),
    process.env.REPOSITORY ?? "",
    Number(process.env.PR_NUMBER ?? ""),
    process.env.HEAD_SHA ?? "",
    process.env.BASE_SHA ?? "",
    process.env.TITLE_FINGERPRINT ?? "",
    process.env.GITHUB_REPOSITORY ?? ""
  );
  await appendLines(process.env.GITHUB_OUTPUT, [`receipt=${receipt}`]);
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
