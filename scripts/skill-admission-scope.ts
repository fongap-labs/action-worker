import { readFileSync } from "node:fs";
import { readRepositoryPolicyText, validateRepositoryCapability } from "./repository-policy.ts";
import { appendLines, CliError, handleError, isMain } from "./runtime-command.ts";
import { parseSkillAdmissionPolicy } from "./skill-proposal-reconcile.ts";

async function main(): Promise<void> {
  const targets = parseSkillAdmissionPolicy(
    JSON.parse(readFileSync("policies/skill-admission.json", "utf8")) as unknown
  ).filter((target) => target.enabled);
  if (targets.length !== 1) {
    throw new CliError("Skill admission requires exactly one approved active target.", 65);
  }
  const target = targets[0]!;
  validateRepositoryCapability(target.repository, JSON.parse(readRepositoryPolicyText()), "pr");
  const control = process.env.GITHUB_REPOSITORY ?? "";
  const requested = process.env.AW_INTAKE_TARGET_REPOSITORY ?? "";
  if (target.repository.split("/")[0] !== control.split("/")[0]) {
    throw new CliError("Cross-owner Skill admission is not supported.", 77);
  }
  const related = !requested || requested === target.repository;
  await appendLines(process.env.GITHUB_OUTPUT, [
    "scan=" + String(related),
    "target_repository=" + target.repository,
    "target_owner=" + target.repository.split("/")[0],
    "target_name=" + target.repository.split("/")[1],
    "read_repositories_csv=" +
      [...new Set([control.split("/")[1], target.repository.split("/")[1]])].join(","),
  ]);
  console.log(
    related ? "Skill admission intake target selected." : "Unrelated intake target; skipped."
  );
}

if (isMain(import.meta.url)) main().catch(handleError);
