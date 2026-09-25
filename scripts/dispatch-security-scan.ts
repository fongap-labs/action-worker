import {
  GithubReader,
  githubEnvironment,
  githubExists,
} from "./github-api.ts";
import { validateRepositoryCapability } from "./repository-policy.ts";
import {
  decodeGithubContent,
  parseSecurityScanManifest,
  resolveSecurityScanFacts,
  scanEnabled,
  type SecurityScanRequest,
} from "./security-scan.ts";
import {
  CliError,
  handleError,
  isMain,
  parseJson,
  runCommand,
} from "./runtime-command.ts";

async function main(): Promise<void> {
  const [repository = "", sourceSha = "", prNumberRaw = "0"] = process.argv.slice(2);
  const prNumber = Number(prNumberRaw);
  const policy = parseJson(
    process.env.AW_REPOSITORY_POLICY ?? "",
    "AW_REPOSITORY_POLICY must be valid JSON.",
    65,
  );
  const controlToken = process.env.AW_CONTROL_TOKEN ?? "";
  const ingressToken = process.env.AW_INGRESS_TOKEN ?? "";
  const controlRepository = process.env.AW_CONTROL_REPOSITORY ?? "";
  if (!controlToken || !ingressToken || !controlRepository || !Number.isInteger(prNumber) || prNumber < 0) {
    throw new CliError("Security scan dispatch environment or PR number is invalid.", 64);
  }
  validateRepositoryCapability(repository, policy, "pr");

  const request: SecurityScanRequest = {
    schema_version: "1",
    request_id: `security-scan:${repository.replace(/[^A-Za-z0-9_.-]/g, "-")}:${sourceSha.slice(0, 12)}`,
    repository,
    source_sha: sourceSha,
    pr_number: prNumber,
  };
  const reader = new GithubReader(process.env.GITHUB_API_URL ?? "https://api.github.com", controlToken);
  const facts = await resolveSecurityScanFacts(reader, request);
  if (facts.is_private) {
    console.log(`Security scan skipped: private source requires a private-safe executor: ${repository}.`);
    return;
  }

  const manifestPath = `repos/${repository}/contents/.github/security-scan.json?ref=${facts.config_ref}`;
  if (!await githubExists(manifestPath, controlToken)) {
    console.log(`Security scan skipped: no trusted manifest for ${repository}@${facts.config_ref}.`);
    return;
  }
  const manifest = parseSecurityScanManifest(
    parseJson(
      decodeGithubContent(await reader.get(manifestPath)),
      "Security scan manifest must be valid JSON.",
      65,
    ),
  );
  if (!scanEnabled(manifest, prNumber)) {
    console.log(`Security scan skipped by source manifest: ${repository}.`);
    return;
  }

  const body = {
    event_type: "run-security-scan",
    client_payload: request,
  };
  await runCommand(
    "gh",
    ["api", "--method", "POST", `repos/${controlRepository}/dispatches`, "--input", "-"],
    {
      env: githubEnvironment(ingressToken),
      input: JSON.stringify(body),
      timeoutMs: 30_000,
      maxBuffer: 1024 * 1024,
    },
  );
  console.log(`Security scan dispatched: ${repository}@${sourceSha}.`);
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
