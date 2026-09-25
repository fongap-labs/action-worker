import {
  GithubReader,
  githubEnvironment,
  githubExists,
} from "./github-api.ts";
import { repositoriesForCapability } from "./repository-policy.ts";
import {
  decodeGithubContent,
  parseSecurityScanManifest,
} from "./security-scan.ts";
import {
  CliError,
  handleError,
  isMain,
  parseJson,
  runCommand,
} from "./runtime-command.ts";

type GithubGet = {
  get(path: string): Promise<unknown>;
};

type Dispatch = (repository: string, sourceSha: string) => Promise<void>;

export type SecurityScanIntakeResult = {
  repositories: number;
  manifests: number;
  dispatched: number;
  skipped: number;
};

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CliError("GitHub response is invalid.", 65);
  }
  return value as Record<string, unknown>;
}

function stringField(value: unknown, field: string): string {
  const item = record(value)[field];
  if (typeof item !== "string" || item.length === 0) {
    throw new CliError(`GitHub response is missing ${field}.`, 65);
  }
  return item;
}

export async function scanDefaultBranchSecurity(
  policyValue: unknown,
  reader: GithubGet,
  manifestExists: (path: string) => Promise<boolean>,
  dispatch: Dispatch,
  controlRepository: string,
): Promise<SecurityScanIntakeResult> {
  const repositories = repositoriesForCapability(policyValue, "pr")
    .filter((repository) => repository !== controlRepository);
  const result: SecurityScanIntakeResult = {
    repositories: repositories.length,
    manifests: 0,
    dispatched: 0,
    skipped: 0,
  };

  for (const repository of repositories) {
    const repositoryValue = await reader.get(`repos/${repository}`);
    const defaultBranch = stringField(repositoryValue, "default_branch");
    const repositoryRecord = record(repositoryValue);
    if (repositoryRecord.private === true) {
      result.skipped += 1;
      continue;
    }
    if (repositoryRecord.private !== false) {
      throw new CliError(`Repository visibility is unavailable: ${repository}.`, 65);
    }
    const commit = await reader.get(`repos/${repository}/commits/${defaultBranch}`);
    const sourceSha = stringField(commit, "sha");
    const path = `repos/${repository}/contents/.github/security-scan.json?ref=${sourceSha}`;
    if (!await manifestExists(path)) {
      result.skipped += 1;
      continue;
    }
    result.manifests += 1;
    const manifest = parseSecurityScanManifest(
      parseJson(
        decodeGithubContent(await reader.get(path)),
        "Security scan manifest must be valid JSON.",
        65,
      ),
    );
    if (!manifest.default_branch) {
      result.skipped += 1;
      continue;
    }
    await dispatch(repository, sourceSha);
    result.dispatched += 1;
  }

  return result;
}

async function main(): Promise<void> {
  const policy = parseJson(
    process.env.AW_REPOSITORY_POLICY ?? "",
    "AW_REPOSITORY_POLICY must be valid JSON.",
    65,
  );
  const controlToken = process.env.AW_CONTROL_TOKEN ?? "";
  const ingressToken = process.env.AW_INGRESS_TOKEN ?? "";
  const controlRepository = process.env.AW_CONTROL_REPOSITORY ?? "";
  if (!controlToken || !ingressToken || !controlRepository) {
    throw new CliError(
      "AW_CONTROL_TOKEN, AW_INGRESS_TOKEN, and AW_CONTROL_REPOSITORY are required.",
      64,
    );
  }

  const reader = new GithubReader(process.env.GITHUB_API_URL ?? "https://api.github.com", controlToken);
  const result = await scanDefaultBranchSecurity(
    policy,
    reader,
    async (path) => await githubExists(path, controlToken),
    async (repository, sourceSha) => {
      const body = {
        event_type: "run-security-scan",
        client_payload: {
          schema_version: "1",
          request_id: `security-scan-scheduled:${repository.replace(/[^A-Za-z0-9_.-]/g, "-")}:${sourceSha.slice(0, 12)}`,
          repository,
          source_sha: sourceSha,
          pr_number: 0,
        },
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
    },
    controlRepository,
  );
  console.log(JSON.stringify(result));
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
