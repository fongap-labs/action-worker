import type { JsonReader } from "./ci-evidence.ts";
import { assertTrustedDevWrite, verifyRecordedDevWrite } from "./dev-write-guard.ts";
import { getJsonString, isJsonRecord } from "./github-api.ts";
import { CliError } from "./runtime-command.ts";

const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const shaPattern = /^[0-9a-f]{40}$/;

/** Shared immutable dev source proof. Channel-specific authorization remains with each caller. */
export async function verifyCurrentBetaSource(
  reader: JsonReader,
  repository: string,
  sha: string,
  controlRepository: string,
  checkChannel?: () => Promise<void>
): Promise<number> {
  if (
    !repositoryPattern.test(repository) ||
    !repositoryPattern.test(controlRepository) ||
    !shaPattern.test(sha) ||
    repository.toLowerCase() === controlRepository.toLowerCase()
  ) {
    throw new CliError("Invalid Beta source identity.", 65);
  }
  const source = await reader.get(`repos/${repository}`);
  if (
    !isJsonRecord(source) ||
    source.private !== false ||
    source.full_name !== repository ||
    source.default_branch !== "main"
  ) {
    throw new CliError("Beta source requires a public managed repository.", 75);
  }
  const assertCurrent = async () => {
    const head = await reader.get(`repos/${repository}/commits/dev`);
    if (getJsonString(head, "sha") !== sha) {
      throw new CliError("Beta source is no longer the current dev HEAD.", 75);
    }
  };
  await assertCurrent();
  await checkChannel?.();
  await assertTrustedDevWrite(reader, repository, sha, controlRepository);
  const proof = await verifyRecordedDevWrite(reader, repository, sha, controlRepository);
  await assertCurrent();
  return proof.scope.prNumber;
}
