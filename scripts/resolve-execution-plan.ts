import {
  type ExecutionArtifact,
  type ExecutionJob,
  type ExecutionOperation,
  jobsForOperation,
  parseExecutionManifest,
} from "./execution-contract.ts";
import {
  parseExecutionCapabilityPolicy,
  validateExecutionGrant,
} from "./execution-policy.ts";
import {
  parseRunnerPolicy,
  resolveRunnerProfile,
} from "./runner-policy.ts";
import {
  CliError,
  appendLines,
  handleError,
  isMain,
  readJson,
} from "./runtime-command.ts";

export type PlannedExecutionJob = {
  job_id: string;
  instance_id: string;
  runner_profile: string;
  runner_backend: string;
  trust_domain: string;
  runner_labels_json: string;
  command_json: string;
  working_directory: string;
  timeout_minutes: number;
  capability_requests_json: string;
  artifacts_json: string;
  matrix_json: string;
};

const matrixTokenPattern = /\{matrix\.([a-z][a-z0-9_]*)\}/g;

function cartesianMatrix(matrix: Record<string, string[]> | undefined): Record<string, string>[] {
  if (!matrix || Object.keys(matrix).length === 0) return [{}];
  const keys = Object.keys(matrix).sort();
  let rows: Record<string, string>[] = [{}];
  for (const key of keys) {
    const values = matrix[key] ?? [];
    rows = rows.flatMap((row) => values.map((value) => ({ ...row, [key]: value })));
    if (rows.length > 128) {
      throw new CliError("Execution matrix expands beyond 128 jobs.", 65);
    }
  }
  return rows;
}

function renderMatrixText(value: string, matrix: Record<string, string>): string {
  return value.replace(matrixTokenPattern, (_, key: string) => {
    if (!(key in matrix)) {
      throw new CliError(`Execution matrix token is unresolved: ${key}.`, 65);
    }
    return matrix[key] ?? "";
  });
}

function renderArtifacts(
  artifacts: readonly ExecutionArtifact[] | undefined,
  matrix: Record<string, string>,
): ExecutionArtifact[] {
  return (artifacts ?? []).map((artifact) => ({
    ...artifact,
    path: renderMatrixText(artifact.path, matrix),
    name: renderMatrixText(artifact.name, matrix),
  }));
}

function instanceId(jobId: string, matrix: Record<string, string>): string {
  const suffix = Object.entries(matrix)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join(",");
  return suffix ? `${jobId}[${suffix}]` : jobId;
}

export function resolveExecutionPlan(
  manifestValue: unknown,
  operation: ExecutionOperation,
  runnerPolicyValue: unknown,
  capabilityPolicyValue: unknown,
): PlannedExecutionJob[] {
  const manifest = parseExecutionManifest(manifestValue);
  const runnerPolicy = parseRunnerPolicy(runnerPolicyValue);
  const capabilityPolicy = parseExecutionCapabilityPolicy(capabilityPolicyValue);
  const jobs = jobsForOperation(manifest, operation);

  if (jobs.some((job) => (job.depends_on?.length ?? 0) > 0)) {
    throw new CliError(
      "Dynamic execution currently requires dependency-free jobs; cross-runner DAG execution is not enabled.",
      65,
    );
  }

  const plan: PlannedExecutionJob[] = [];
  for (const job of jobs) {
    const resolved = resolveRunnerProfile(runnerPolicy, job.runner_profile);
    validateExecutionGrant(capabilityPolicy, operation, job, resolved.profile.trust_domain);

    for (const matrix of cartesianMatrix(job.matrix)) {
      const renderedCommand = job.command.map((value) => renderMatrixText(value, matrix));
      const renderedWorkingDirectory = job.working_directory
        ? renderMatrixText(job.working_directory, matrix)
        : "";
      const renderedArtifacts = renderArtifacts(job.artifacts, matrix);
      plan.push({
        job_id: job.id,
        instance_id: instanceId(job.id, matrix),
        runner_profile: resolved.name,
        runner_backend: resolved.profile.backend,
        trust_domain: resolved.profile.trust_domain,
        runner_labels_json: JSON.stringify(resolved.profile.labels),
        command_json: JSON.stringify(renderedCommand),
        working_directory: renderedWorkingDirectory,
        timeout_minutes: job.timeout_minutes,
        capability_requests_json: JSON.stringify(job.capability_requests),
        artifacts_json: JSON.stringify(renderedArtifacts),
        matrix_json: JSON.stringify(matrix),
      });
    }
  }

  if (plan.length === 0) {
    throw new CliError(`Execution plan is empty for operation: ${operation}.`, 65);
  }
  return plan;
}

async function main(): Promise<void> {
  const [
    manifestPath = "",
    operationRaw = "",
    runnerPolicyPath = "policies/runner.json",
    capabilityPolicyPath = "policies/capabilities.json",
  ] = process.argv.slice(2);
  if (!manifestPath || !operationRaw) {
    throw new CliError(
      "Usage: resolve-execution-plan.ts <manifest> <operation> [runner-policy] [capability-policy]",
      64,
    );
  }
  const allowedOperations = new Set([
    "ci", "review", "build", "release", "deploy", "task", "scheduled",
  ]);
  if (!allowedOperations.has(operationRaw)) {
    throw new CliError(`Unknown execution operation: ${operationRaw}.`, 64);
  }

  const plan = resolveExecutionPlan(
    await readJson(manifestPath),
    operationRaw as ExecutionOperation,
    await readJson(runnerPolicyPath),
    await readJson(capabilityPolicyPath),
  );
  const matrix = { include: plan };
  await appendLines(process.env.GITHUB_OUTPUT, [
    `matrix=${JSON.stringify(matrix)}`,
    `job_count=${plan.length}`,
  ]);
  console.log(JSON.stringify(matrix));
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
