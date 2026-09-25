import { GithubReader } from "./github-api.ts";
import {
  decodeGithubContent,
  parseDependencyRepairManifest,
  parseDependencyRepairRequest,
  resolveDependencyRepairFacts,
  selectDependencyRepair,
} from "./dependency-repair.ts";
import { validateRepositoryCapability } from "./repository-policy.ts";
import { parseRunnerPolicy, resolveRunnerProfile } from "./runner-policy.ts";
import {
  CliError,
  appendLines,
  handleError,
  isMain,
  parseJson,
  readJson,
} from "./runtime-command.ts";

async function main(): Promise<void> {
  const request = parseDependencyRepairRequest(
    parseJson(
      process.env.DEPENDENCY_REPAIR_REQUEST_JSON ?? "",
      "DEPENDENCY_REPAIR_REQUEST_JSON must be valid JSON.",
      64,
    ),
  );
  const repositoryPolicy = parseJson(
    process.env.AW_REPOSITORY_POLICY ?? "",
    "AW_REPOSITORY_POLICY must be valid JSON.",
    65,
  );
  const token = process.env.AW_CONTROL_TOKEN ?? "";
  if (!token) {
    throw new CliError("AW_CONTROL_TOKEN is required.", 77);
  }

  validateRepositoryCapability(request.repository, repositoryPolicy, "pr");

  const reader = new GithubReader(process.env.GITHUB_API_URL ?? "https://api.github.com", token);
  const facts = await resolveDependencyRepairFacts(reader, request);
  const manifestResponse = await reader.get(
    `repos/${request.repository}/contents/.github/dependency-repair.json?ref=${facts.base_sha}`,
  );
  const manifest = parseDependencyRepairManifest(
    parseJson(
      decodeGithubContent(manifestResponse),
      "Dependency repair manifest must be valid JSON.",
      65,
    ),
  );
  const repair = selectDependencyRepair(manifest, facts);
  if (!repair) {
    await appendLines(process.env.GITHUB_OUTPUT, [
      "enabled=false",
      `repository=${facts.repository}`,
      `pr_number=${facts.pr_number}`,
      `head_sha=${facts.head_sha}`,
      `head_ref=${facts.head_ref}`,
      `base_sha=${facts.base_sha}`,
    ]);
    console.log(JSON.stringify({ enabled: false, ...facts }));
    return;
  }

  const runnerPolicy = parseRunnerPolicy(await readJson(process.argv[2] ?? "policies/runner.json"));
  const resolved = resolveRunnerProfile(runnerPolicy, repair.runner_profile);
  if (resolved.profile.trust_domain !== "sandbox") {
    throw new CliError(
      `Dependency repair compute must run in the sandbox trust domain: ${repair.runner_profile}.`,
      77,
    );
  }

  await appendLines(process.env.GITHUB_OUTPUT, [
    "enabled=true",
    `repository=${facts.repository}`,
    `pr_number=${facts.pr_number}`,
    `head_sha=${facts.head_sha}`,
    `head_ref=${facts.head_ref}`,
    `base_sha=${facts.base_sha}`,
    `actor=${facts.actor}`,
    `repair_id=${repair.id}`,
    `adapter=${repair.adapter}`,
    `tool_version=${repair.tool_version}`,
    `working_directory=${repair.working_directory}`,
    `output_paths_json=${JSON.stringify(repair.output_paths)}`,
    `runner_labels_json=${JSON.stringify(resolved.profile.labels)}`,
  ]);

  console.log(JSON.stringify({
    enabled: true,
    repository: facts.repository,
    pr_number: facts.pr_number,
    head_sha: facts.head_sha,
    head_ref: facts.head_ref,
    base_sha: facts.base_sha,
    actor: facts.actor,
    repair_id: repair.id,
    adapter: repair.adapter,
    runner_profile: resolved.name,
    output_paths: repair.output_paths,
  }));
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
