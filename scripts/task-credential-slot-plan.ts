import { readSecretAliases, readTaskSecretCeiling } from "./resolve-secret-scope.ts";
import { CliError } from "./runtime-command.ts";

// GitHub Actions must reference each Secret explicitly in the future isolated task Job.
// This plan contains NAMES ONLY and never reads or forwards Secret values.
export const maxTaskCredentialSlots = 32;

export type TaskCredentialSlot = {
  slot: string;
  logical_name: string;
  stored_name: string;
  required: boolean;
};

const namePattern = /^[A-Z][A-Z0-9_]*$/;

function validatedNames(names: readonly string[], label: string): string[] {
  const result = new Set<string>();
  for (const name of names) {
    if (
      typeof name !== "string" ||
      !namePattern.test(name) ||
      /^(?:AW_|GITHUB_|RUNNER_|ACTIONS_)/.test(name) ||
      name === "GH_TOKEN" ||
      name === "NODE_OPTIONS" ||
      result.has(name)
    ) {
      throw new CliError(`Task credential ${label} declaration is invalid.`, 65);
    }
    result.add(name);
  }
  return [...result];
}

export async function buildTaskCredentialSlotPlan(
  policyPath: string,
  repository: string,
  project: string,
  required: readonly string[],
  allowed: readonly string[]
): Promise<TaskCredentialSlot[]> {
  const requiredNames = validatedNames(required, "required");
  const optionalNames = validatedNames(allowed, "allowed");
  const requiredSet = new Set(requiredNames);
  const declared = [...requiredNames, ...optionalNames];
  if (new Set(declared).size !== declared.length || declared.length > maxTaskCredentialSlots) {
    throw new CliError("Task credential slots are overlapping or exceed the limit.", 65);
  }

  const ceiling = await readTaskSecretCeiling(policyPath, repository, project, declared);
  if (declared.some((name) => !ceiling.has(name))) {
    throw new CliError("Task credential declaration exceeds the central policy ceiling.", 65);
  }
  const aliases = await readSecretAliases(policyPath, "task", repository, project);
  const usedSources = new Set<string>();
  const ordered = declared.sort((a, b) => a.localeCompare(b));
  return ordered.map((name, index) => {
    const stored = aliases.get(name) ?? name;
    if (
      !namePattern.test(stored) ||
      /^(?:AW_|GITHUB_|RUNNER_|ACTIONS_)/.test(stored) ||
      stored === "GH_TOKEN" ||
      stored === "NODE_OPTIONS" ||
      usedSources.has(stored)
    ) {
      throw new CliError("Task credential source is invalid or shared across slots.", 65);
    }
    // Cloudflare's account API token is not an R2 S3 Access Key ID.
    // Block automatic binding until the consumer's real credential type is verified.
    if (name === "CLOUDFLARE_ACCESS_KEY" && /^CLOUDFLARE_API_TOKEN(?:_|$)/.test(stored)) {
      throw new CliError("Task R2 Access Key source requires credential-type verification.", 77);
    }
    usedSources.add(stored);
    return {
      slot: `AW_TASK_SECRET_SLOT_${String(index + 1).padStart(2, "0")}`,
      logical_name: name,
      stored_name: stored,
      required: requiredSet.has(name),
    };
  });
}
