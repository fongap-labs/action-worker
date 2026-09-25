import { GithubReader } from "./github-api.ts";
import {
  decodeGithubContent,
  parseSecurityScanManifest,
  parseSecurityScanRequest,
  resolveSecurityScanFacts,
  scanEnabled,
} from "./security-scan.ts";
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
  const request = parseSecurityScanRequest(
    parseJson(
      process.env.SECURITY_SCAN_REQUEST_JSON ?? "",
      "SECURITY_SCAN_REQUEST_JSON must be valid JSON.",
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
  const facts = await resolveSecurityScanFacts(reader, request);
  if (facts.is_private) {
    throw new CliError(
      "Private repository CodeQL is not enabled on the public control plane because scan logs may expose source metadata.",
      77,
    );
  }

  const manifestValue = await reader.get(
    `repos/${facts.repository}/contents/.github/security-scan.json?ref=${facts.config_ref}`,
  );
  const manifest = parseSecurityScanManifest(
    parseJson(
      decodeGithubContent(manifestValue),
      "Security scan manifest must be valid JSON.",
      65,
    ),
  );
  if (!scanEnabled(manifest, facts.pr_number)) {
    throw new CliError("Security scan is disabled for this source type.", 78);
  }

  const runnerPolicy = parseRunnerPolicy(await readJson(process.argv[2] ?? "policies/runner.json"));
  const resolved = resolveRunnerProfile(runnerPolicy, manifest.runner_profile);
  if (resolved.profile.trust_domain !== "sandbox") {
    throw new CliError(
      `Security analysis must run in the sandbox trust domain: ${manifest.runner_profile}.`,
      77,
    );
  }

  const matrix = {
    include: manifest.languages.map((language) => ({
      language,
      build_mode: manifest.build_mode,
      runner_profile: resolved.name,
      runner_labels_json: JSON.stringify(resolved.profile.labels),
    })),
  };

  await appendLines(process.env.GITHUB_OUTPUT, [
    `repository=${facts.repository}`,
    `source_sha=${facts.source_sha}`,
    `pr_number=${facts.pr_number}`,
    `ref=${facts.ref}`,
    `config_ref=${facts.config_ref}`,
    `default_branch=${facts.default_branch}`,
    `matrix=${JSON.stringify(matrix)}`,
  ]);
  console.log(JSON.stringify({ ...facts, matrix }));
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
