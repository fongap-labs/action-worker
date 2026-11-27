import { branchAuthorizationWorkflow } from "./dev-bootstrap-authorization.ts";
import { getJsonNumber, getJsonString, isJsonRecord } from "./github-api.ts";
import { CliError } from "./runtime-command.ts";

type Reader = { get(path: string): Promise<unknown> };

const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const loginPattern = /^[A-Za-z0-9-]{1,39}$/;

/** Explicit manual dispatch by the same current human-account administrator on both repositories. */
export async function assertManualBranchAuthorization(
  reader: Reader,
  controlRepository: string,
  repository: string,
  runId: number,
  attempt: number,
  canSelfBootstrap = false
): Promise<void> {
  if (
    !repositoryPattern.test(controlRepository) ||
    !repositoryPattern.test(repository) ||
    (repository === controlRepository && !canSelfBootstrap) ||
    !Number.isSafeInteger(runId) ||
    runId < 1 ||
    attempt !== 1
  ) {
    throw new CliError("Branch authorization requires a fresh manual run.", 75);
  }
  const run = await reader.get(`repos/${controlRepository}/actions/runs/${runId}`);
  if (
    !isJsonRecord(run) ||
    getJsonNumber(run, "id") !== runId ||
    getJsonNumber(run, "run_attempt") !== attempt ||
    getJsonString(run.repository, "full_name") !== controlRepository ||
    getJsonString(run, "event") !== "workflow_dispatch" ||
    getJsonString(run, "head_branch") !== "main" ||
    getJsonString(run, "path") !== branchAuthorizationWorkflow ||
    getJsonString(run, "status") !== "in_progress"
  ) {
    throw new CliError("Branch authorization requires the current trusted manual run.", 75);
  }
  const actorId = getJsonNumber(run.actor, "id");
  const login = getJsonString(run.actor, "login");
  if (
    !loginPattern.test(login) ||
    !Number.isSafeInteger(actorId) ||
    actorId < 1 ||
    getJsonString(run.actor, "type") !== "User" ||
    getJsonString(run.triggering_actor, "type") !== "User" ||
    getJsonNumber(run.triggering_actor, "id") !== actorId ||
    getJsonString(run.triggering_actor, "login") !== login
  ) {
    throw new CliError("Branch authorization requires an explicit user administrator.", 77);
  }
  for (const target of new Set([controlRepository, repository])) {
    const permission = await reader.get(`repos/${target}/collaborators/${login}/permission`);
    if (
      !isJsonRecord(permission) ||
      getJsonString(permission, "permission") !== "admin" ||
      getJsonNumber(permission.user, "id") !== actorId ||
      getJsonString(permission.user, "login") !== login ||
      getJsonString(permission.user, "type") !== "User"
    ) {
      throw new CliError("Branch authorization requires current administrator access.", 77);
    }
  }
}
