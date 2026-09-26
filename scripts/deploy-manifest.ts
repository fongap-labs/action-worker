import {
  GithubReader,
  isJsonRecord,
} from "./github-api.ts";
import {
  CliError,
  appendLines,
  handleError,
  isMain,
  parseJson,
  readJson,
} from "./runtime-command.ts";
import { validateRepositoryCapability } from "./repository-policy.ts";
import {
  parseRunnerPolicy,
  resolveRunnerProfile,
} from "./runner-policy.ts";

export type DeployAdapter = "source-script";

export type DeployManifest = {
  schema_version: "1";
  adapter: DeployAdapter;
  automatic: boolean;
  ignore_docs_only: boolean;
  runner_profile: string;
  environment: string;
  entrypoint: string;
};

const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const shaPattern = /^[0-9a-f]{40}$/;
const namePattern = /^[a-z][a-z0-9-]{0,63}$/;
const pathPattern = /^[A-Za-z0-9._/-]+$/;

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((item, index) => item !== wanted[index])) {
    throw new CliError("Deploy manifest keys are invalid.", 65);
  }
}

function safeRelativePath(value: string): boolean {
  return Boolean(value)
    && pathPattern.test(value)
    && !value.startsWith("/")
    && !value.split("/").includes("..");
}

export function decodeDeployManifestContent(value: unknown): string {
  if (!isJsonRecord(value) || value.encoding !== "base64" || typeof value.content !== "string") {
    throw new CliError("GitHub deploy manifest response is invalid.", 65);
  }
  return Buffer.from(value.content.replace(/\s+/g, ""), "base64").toString("utf8");
}

export function parseDeployManifest(value: unknown): DeployManifest {
  if (!isJsonRecord(value)) {
    throw new CliError("Deploy manifest must be an object.", 65);
  }
  exactKeys(value, [
    "adapter",
    "automatic",
    "entrypoint",
    "environment",
    "ignore_docs_only",
    "runner_profile",
    "schema_version",
  ]);
  if (value.schema_version !== "1"
    || value.adapter !== "source-script"
    || typeof value.automatic !== "boolean"
    || typeof value.ignore_docs_only !== "boolean"
    || typeof value.runner_profile !== "string" || !namePattern.test(value.runner_profile)
    || typeof value.environment !== "string" || !namePattern.test(value.environment)
    || typeof value.entrypoint !== "string"
  ) {
    throw new CliError("Deploy manifest is invalid.", 65);
  }

  if (!safeRelativePath(value.entrypoint)) {
    throw new CliError("Source-script deploy manifest requires a safe relative entrypoint.", 65);
  }

  return value as DeployManifest;
}

export type ResolvedDeployManifest = DeployManifest & {
  repository: string;
  source_sha: string;
  runner_backend: string;
  trust_domain: string;
  runner_labels_json: string;
};

export async function resolveDeployManifest(
  repository: string,
  sourceSha: string,
  repositoryPolicyValue: unknown,
  runnerPolicyValue: unknown,
  reader: { get(path: string): Promise<unknown> },
): Promise<ResolvedDeployManifest> {
  if (!repositoryPattern.test(repository) || !shaPattern.test(sourceSha)) {
    throw new CliError("Deploy manifest source identity is invalid.", 64);
  }
  validateRepositoryCapability(repository, repositoryPolicyValue, "deploy");

  const manifestResponse = await reader.get(
    `repos/${repository}/contents/.github/deploy.json?ref=${sourceSha}`,
  );
  const manifest = parseDeployManifest(
    parseJson(
      decodeDeployManifestContent(manifestResponse),
      `Deploy manifest must be valid JSON: ${repository}.`,
      65,
    ),
  );
  const runnerPolicy = parseRunnerPolicy(runnerPolicyValue);
  const resolvedRunner = resolveRunnerProfile(runnerPolicy, manifest.runner_profile);
  if (resolvedRunner.profile.trust_domain !== "privileged") {
    throw new CliError(
      `Deploy runner profile must use the privileged trust domain: ${manifest.runner_profile}.`,
      77,
    );
  }

  if (manifest.entrypoint) {
    await reader.get(
      `repos/${repository}/contents/${manifest.entrypoint}?ref=${sourceSha}`,
    );
  }

  return {
    ...manifest,
    repository,
    source_sha: sourceSha,
    runner_backend: resolvedRunner.profile.backend,
    trust_domain: resolvedRunner.profile.trust_domain,
    runner_labels_json: JSON.stringify(resolvedRunner.profile.labels),
  };
}

async function main(): Promise<void> {
  const [repository = "", sourceSha = "", runnerPolicyPath = "policies/runner.json"] = process.argv.slice(2);
  const token = process.env.AW_CONTROL_TOKEN ?? "";
  const rawRepositoryPolicy = process.env.AW_REPOSITORY_POLICY ?? "";
  if (!token || !rawRepositoryPolicy) {
    throw new CliError("AW_CONTROL_TOKEN and AW_REPOSITORY_POLICY are required.", 77);
  }

  const resolved = await resolveDeployManifest(
    repository,
    sourceSha,
    parseJson(rawRepositoryPolicy, "AW_REPOSITORY_POLICY must be valid JSON.", 65),
    await readJson(runnerPolicyPath),
    new GithubReader(process.env.GITHUB_API_URL ?? "https://api.github.com", token),
  );

  await appendLines(process.env.GITHUB_OUTPUT, [
    `adapter=${resolved.adapter}`,
    `automatic=${resolved.automatic}`,
    `ignore_docs_only=${resolved.ignore_docs_only}`,
    `runner_profile=${resolved.runner_profile}`,
    `runner_backend=${resolved.runner_backend}`,
    `runner_labels_json=${resolved.runner_labels_json}`,
    `trust_domain=${resolved.trust_domain}`,
    `environment=${resolved.environment}`,
    `entrypoint=${resolved.entrypoint}`,
  ]);
  console.log(JSON.stringify(resolved));
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
