import { isDeepStrictEqual } from "node:util";
import { type JsonReader, trustedControlRunId } from "./ci-evidence.ts";
import {
  bootstrapIntegrationId,
  devRulesetSnapshot,
  temporaryDevGuardName,
} from "./create-protected-dev.ts";
import {
  branchAuthorizationWorkflow,
  devBootstrapContext,
  isClosedDevProtection,
  verifyBootstrapSource,
} from "./dev-bootstrap-authorization.ts";
import { getJsonNumber, getJsonString, isJsonRecord } from "./github-api.ts";
import { ProtectionReadError } from "./protection-read-scope.ts";
import {
  latestAttestedStatus,
  originalStatusDescription,
  statusRunAttempt,
} from "./status-attestation.ts";

const windowMs = 24 * 60 * 60 * 1000;

function within(value: number, start: number, end: number): boolean {
  return (
    Number.isFinite(value) &&
    Number.isFinite(start) &&
    Number.isFinite(end) &&
    value >= start &&
    value <= end
  );
}

/** Recover only an already-created, fully closed branch with an attested manual approval.
 * The failed publisher is never accepted as a successful workflow. The current audit
 * independently verifies the immutable source, the failed final step and the exact
 * redundant guard before removing it and issuing its own normal write attestation.
 */
export async function recoverInterruptedDevBootstrap(
  reader: JsonReader,
  repository: string,
  sha: string,
  statuses: unknown,
  controlRepository: string,
  deleteGuard: (id: number) => Promise<void>,
  now = Date.now()
): Promise<string | undefined> {
  const receipt = latestAttestedStatus(statuses, {
    repository,
    sha,
    context: devBootstrapContext,
  });
  if (
    receipt?.state !== "success" ||
    originalStatusDescription(receipt) !== `init-v1=${sha}` ||
    statusRunAttempt(receipt) !== 1
  ) {
    return undefined;
  }
  const receiptAt = Date.parse(getJsonString(receipt, "created_at"));
  if (!within(receiptAt, now - windowMs, now)) return undefined;
  const runId = trustedControlRunId(getJsonString(receipt, "target_url"), controlRepository);
  if (runId === null) return undefined;
  const runPath = `repos/${controlRepository}/actions/runs/${runId}`;
  const run = await reader.get(runPath);
  if (
    !isJsonRecord(run) ||
    getJsonNumber(run, "id") !== runId ||
    getJsonString(run.repository, "full_name") !== controlRepository ||
    run.path !== branchAuthorizationWorkflow ||
    run.head_branch !== "main" ||
    run.event !== "workflow_dispatch" ||
    run.run_attempt !== 1 ||
    run.status !== "completed" ||
    run.conclusion !== "failure"
  ) {
    return undefined;
  }
  const actorId = getJsonNumber(run.actor, "id");
  const login = getJsonString(run.actor, "login");
  if (
    actorId < 1 ||
    !/^[A-Za-z0-9-]{1,39}$/.test(login) ||
    getJsonString(run.actor, "type") !== "User" ||
    getJsonString(run.triggering_actor, "type") !== "User" ||
    getJsonNumber(run.triggering_actor, "id") !== actorId ||
    getJsonString(run.triggering_actor, "login") !== login ||
    !within(
      receiptAt,
      Date.parse(getJsonString(run, "run_started_at")),
      Date.parse(getJsonString(run, "updated_at"))
    )
  ) {
    return undefined;
  }
  const jobs = await reader.get(`${runPath}/attempts/1/jobs?per_page=100`);
  if (!isJsonRecord(jobs) || jobs.total_count !== 1 || !Array.isArray(jobs.jobs)) {
    return undefined;
  }
  const job = jobs.jobs[0];
  if (
    !isJsonRecord(job) ||
    job.run_attempt !== 1 ||
    job.name !== "Check and authorize managed branch operation" ||
    job.conclusion !== "failure" ||
    !Array.isArray(job.steps)
  ) {
    return undefined;
  }
  const steps = job.steps;
  const succeeded = (name: string) =>
    steps.filter((step) => getJsonString(step, "name") === name).length === 1 &&
    steps.some(
      (step) =>
        getJsonString(step, "name") === name && getJsonString(step, "conclusion") === "success"
    );
  if (
    ![
      "Check source and display authorization scope",
      "Verify approval before issuing initialization receipt",
      "Mint initialization receipt token",
      "Mint repository-scoped initialization ref token",
    ].every(succeeded)
  ) {
    return undefined;
  }
  const failed = steps.filter(
    (step) => getJsonString(step, "name") === "Record approved authorization and initialize dev"
  );
  if (
    failed.length !== 1 ||
    getJsonString(failed[0], "conclusion") !== "failure" ||
    steps.filter((step) => getJsonString(step, "conclusion") === "failure").length !== 1
  ) {
    return undefined;
  }
  const start = Date.parse(getJsonString(failed[0], "started_at"));
  const end = Date.parse(getJsonString(failed[0], "completed_at"));
  if (!within(receiptAt, start, end)) return undefined;

  const prefix = `repos/${repository}/rulesets`;
  const listPath = `${prefix}?includes_parents=false&per_page=100`;
  const listed = await reader.get(listPath);
  if (!Array.isArray(listed)) return undefined;
  const closed = listed.filter((rule) => getJsonString(rule, "name") === "Protect Dev Branch");
  const guards = listed.filter((rule) => getJsonString(rule, "name") === temporaryDevGuardName);
  const closedId = getJsonNumber(closed[0], "id");
  const guardId = getJsonNumber(guards[0], "id");
  if (
    closed.length !== 1 ||
    guards.length !== 1 ||
    !Number.isSafeInteger(closedId) ||
    !Number.isSafeInteger(guardId) ||
    closedId < 1 ||
    guardId < 1 ||
    closedId === guardId
  ) {
    return undefined;
  }
  const detail = (id: number) => `${prefix}/${id}?includes_parents=false`;
  const readClosed = async () => {
    const rule = devRulesetSnapshot(await reader.get(detail(closedId)));
    return isClosedDevProtection(rule) && Array.isArray(rule.rules) && rule.rules.length === 4
      ? rule
      : undefined;
  };
  const original = await readClosed();
  if (!original) return undefined;
  const guard = await reader.get(detail(guardId));
  const expected = {
    name: temporaryDevGuardName,
    target: "branch",
    enforcement: "active",
    conditions: original.conditions,
    bypass_actors: [
      { actor_id: bootstrapIntegrationId(), actor_type: "Integration", bypass_mode: "always" },
    ],
    rules: [{ type: "creation" }],
  };
  if (
    !isDeepStrictEqual(devRulesetSnapshot(guard), expected) ||
    !within(Date.parse(getJsonString(guard, "created_at")), receiptAt, end + 1000) ||
    !within(Date.parse(getJsonString(guard, "updated_at")), receiptAt, end + 1000)
  ) {
    return undefined;
  }
  await verifyBootstrapSource(reader, repository, sha, controlRepository, true);
  if (
    !isDeepStrictEqual(await readClosed(), original) ||
    !isDeepStrictEqual(devRulesetSnapshot(await reader.get(detail(guardId))), expected)
  ) {
    throw new ProtectionReadError("Development protection changed during recovery.");
  }
  try {
    await deleteGuard(guardId);
  } catch {
    throw new ProtectionReadError("Redundant development creation guard cleanup failed.");
  }
  const remaining = await reader.get(listPath);
  if (
    !Array.isArray(remaining) ||
    remaining.some((rule) => getJsonString(rule, "name") === temporaryDevGuardName) ||
    !isDeepStrictEqual(await readClosed(), original)
  ) {
    throw new ProtectionReadError("Development creation guard cleanup could not be verified.");
  }
  await verifyBootstrapSource(reader, repository, sha, controlRepository, true);
  return `init-v1=${sha}`;
}
