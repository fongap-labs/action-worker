import { readFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { getJsonString, isJsonRecord, statusAwareReader } from "./github-api.ts";
import { hasVerifiedMainWriteGuard } from "./main-write-guard.ts";
import { readRepositoryPolicyText, validateRepositoryCapability } from "./repository-policy.ts";
import { CliError, handleError, isMain, parseJson } from "./runtime-command.ts";
import { inspectSkillProposals, parseSkillAdmissionPolicy } from "./skill-proposal-reconcile.ts";

const SHA = /^[0-9a-f]{40}$/;
const REPO = /^[a-z0-9-]{1,39}\/[a-z0-9_.-]{1,100}$/;

type GithubErrorCtor = new (status: number, repository: string, method: string) => Error;

function boundedGitHubPath(path: string, repository: string): string {
  const root = "/repos/" + repository;
  if (
    (path !== root && !path.startsWith(root + "/")) ||
    path.includes("..") ||
    path.includes("\\") ||
    path.includes("#") ||
    [...path].some((char) => {
      const code = char.charCodeAt(0);
      return code < 32 || code === 127;
    }) ||
    path.length > 1024
  ) {
    throw new CliError("Cross-repository or unsafe Skill promotion GitHub path.", 77);
  }
  return path;
}

function boundedPublicPath(path: string): string {
  if (
    !/^\/repos\/[a-z0-9-]{1,39}\/[a-z0-9_.-]{1,100}\/(?:commits\/[0-9a-f]{40}|git\/trees\/[0-9a-f]{40}\?recursive=1|git\/blobs\/[0-9a-f]{40})$/i.test(
      path
    )
  ) {
    throw new CliError("Skill source audit must use an immutable anonymous GitHub endpoint.", 77);
  }
  return path;
}

async function getBoundedJson(
  uri: string,
  token: string | undefined,
  signal: AbortSignal,
  method = "GET",
  data?: unknown,
  limit = 2_000_000
): Promise<{ status: number; value: unknown }> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = "Bearer " + token;
  if (data !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(uri, {
    method,
    headers,
    redirect: "error",
    signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  if (!response.ok) return { status: response.status, value: undefined };
  const length = Number(response.headers.get("content-length") || "0");
  if (length > limit) throw new CliError("GitHub Skill promotion response too large.", 65);
  const raw = await response.text();
  if (Buffer.byteLength(raw, "utf8") > limit) {
    throw new CliError("GitHub Skill promotion response exceeds byte limit.", 65);
  }
  return { status: response.status, value: JSON.parse(raw) as unknown };
}

/** Two separately scoped App tokens, and anonymous public reads with no token fallback. */
export function makeOwnerBoundSkillTransport(
  repository: string,
  account: string,
  readToken: string,
  writeToken: string,
  GithubApiFailure: GithubErrorCtor
): {
  request(input: {
    repository: string;
    account: string;
    method: "GET" | "POST" | "PUT" | "PATCH";
    path: string;
    data?: unknown;
    signal: AbortSignal;
  }): Promise<{ repository: string; account: string; data: unknown }>;
  publicRead(path: string, signal: AbortSignal): Promise<unknown>;
} {
  if (
    !REPO.test(repository) ||
    account.toLowerCase() !== repository.split("/")[0]!.toLowerCase() ||
    !readToken ||
    !writeToken ||
    readToken === writeToken
  ) {
    throw new CliError("Skill promotion requires independent owner-scoped read/write tokens.", 77);
  }
  return {
    async request(input) {
      if (
        input.repository !== repository ||
        input.account.toLowerCase() !== account.toLowerCase() ||
        !["GET", "POST", "PUT", "PATCH"].includes(input.method)
      ) {
        throw new CliError("Owner-bound Skill promotion transport rejected request.", 77);
      }
      const path = boundedGitHubPath(input.path, repository);
      const token = input.method === "GET" ? readToken : writeToken;
      const { status, value } = await getBoundedJson(
        "https://api.github.com" + path,
        token,
        input.signal,
        input.method,
        input.data
      );
      if (status < 200 || status >= 300) {
        throw new GithubApiFailure(status, repository, input.method);
      }
      return { repository, account, data: value };
    },
    async publicRead(path, signal) {
      const safePath = boundedPublicPath(path);
      const { status, value } = await getBoundedJson(
        "https://api.github.com" + safePath,
        undefined,
        signal
      );
      if (status !== 200)
        throw new CliError("Anonymous immutable Skill audit failed (" + status + ").", 75);
      return value;
    },
  };
}

async function main(): Promise<void> {
  const readToken = process.env.AW_CONTROL_TOKEN ?? "";
  const statusToken = process.env.AW_STATUS_API_TOKEN ?? "";
  const writeToken = process.env.AW_SKILL_WRITE_TOKEN ?? "";
  const repository = process.env.AW_SKILL_TARGET_REPOSITORY ?? "";
  const requestedHead = process.env.AW_SKILL_PROPOSAL_HEAD ?? "";
  const proposedNumber = Number(process.env.AW_SKILL_PROPOSAL_NUMBER ?? "");
  const sourceRoot = process.env.AW_SKILL_SOURCE_ROOT ?? "";
  const controlRepository = process.env.GITHUB_REPOSITORY ?? "";
  const expectedMain = process.env.AW_SKILL_PLUGIN_MAIN_SHA ?? "";
  if (
    !readToken ||
    !statusToken ||
    !writeToken ||
    !process.env.AW_STATUS_KEYRING ||
    !REPO.test(repository) ||
    !REPO.test(controlRepository) ||
    !SHA.test(requestedHead) ||
    !SHA.test(expectedMain) ||
    !Number.isSafeInteger(proposedNumber) ||
    proposedNumber < 1 ||
    !sourceRoot
  ) {
    throw new CliError("Missing immutable Skill promotion inputs or scoped credentials.", 77);
  }
  const rawPolicy = JSON.parse(readFileSync("policies/skill-admission.json", "utf8")) as unknown;
  const target = parseSkillAdmissionPolicy(rawPolicy).find(
    (item) => item.enabled && item.repository === repository
  );
  if (!target || repository.split("/")[0] !== controlRepository.split("/")[0]) {
    throw new CliError("Target repository is not enabled for Skill promotion.", 77);
  }
  validateRepositoryCapability(
    repository,
    parseJson(readRepositoryPolicyText(), "Invalid repository policy.", 65),
    "pr"
  );
  const reader = statusAwareReader(
    process.env.GITHUB_API_URL ?? "https://api.github.com",
    readToken,
    statusToken
  );
  // The workflow must check out only a signed target main revision. Never run
  // plugin code from an external contributor's PR branch or mutable remote ref.
  const main = await reader.get("repos/" + repository + "/commits/main");
  if (!isJsonRecord(main) || getJsonString(main, "sha") !== expectedMain) {
    throw new CliError("Plugin main changed since verified inspection.", 75);
  }
  const mainStatus = await reader.get(
    "repos/" + repository + "/commits/" + expectedMain + "/status"
  );
  if (!(await hasVerifiedMainWriteGuard(reader, mainStatus, repository, expectedMain))) {
    throw new CliError("Plugin source main lacks a verified trusted Main Write Guard.", 75);
  }
  const inspected = await inspectSkillProposals(reader, target, controlRepository);
  if (
    !inspected ||
    inspected.proposalPrNumber !== proposedNumber ||
    inspected.expectedProposalHead !== requestedHead
  ) {
    throw new CliError("Selected merged proposal changed or was already promoted.", 75);
  }

  const root = await realpath(resolve(sourceRoot));
  const builtPath = resolve(
    root,
    "packages/dsh-delta-code/lib/delta-code-repository/github-operations.js"
  );
  const path = await realpath(builtPath);
  if (!path.startsWith(root + sep)) {
    throw new CliError("Trusted plugin module escaped pinned source checkout.", 77);
  }
  // This import is the central CI-checked plugin's existing promoted Skill tool,
  // not a second implementation of trust, review or catalog-writing rules.
  const moduleValue = (await import(pathToFileURL(path).href)) as {
    createGitHubToolSpecs: (
      settings: unknown,
      transport: unknown,
      resolver: (repo?: string) => Promise<string>
    ) => Array<{ name: string; execute(args: unknown, context: unknown): Promise<unknown> }>;
  };
  const errorsPath = resolve(
    root,
    "packages/dsh-delta-code/lib/delta-code-adapter/contracts/github.js"
  );
  const errorsModule = (await import(pathToFileURL(await realpath(errorsPath)).href)) as {
    GitHubApiFailure: GithubErrorCtor;
  };
  const account = repository.split("/")[0]!;
  const transport = makeOwnerBoundSkillTransport(
    repository,
    account,
    readToken,
    writeToken,
    errorsModule.GitHubApiFailure
  );
  const settings = {
    githubAllowWrites: true,
    githubAccounts: [{ owner: account }],
  };
  const specs = moduleValue.createGitHubToolSpecs(settings, transport, async (requested) => {
    if (requested !== repository) throw new CliError("Unmatched owner-bound Skill target.", 77);
    return repository;
  });
  const promote = specs.find((spec) => spec.name === "code_github_skill_auto_advance");
  if (!promote) throw new CliError("Trusted plugin lacks the auto-advance tool.", 75);
  const result = await promote.execute(
    {
      targetRepository: repository,
      proposalPrNumber: inspected.proposalPrNumber,
      expectedProposalHead: inspected.expectedProposalHead,
      ...inspected.source,
      account,
    },
    { signal: AbortSignal.timeout(150_000), account }
  );
  if (!isJsonRecord(result) || typeof result.result !== "string") {
    throw new CliError("Skill promotion tool returned an invalid result.", 75);
  }
  const receipt: unknown = JSON.parse(result.result);
  if (
    !isJsonRecord(receipt) ||
    receipt.state !== "awaiting-catalog-ci" ||
    !isJsonRecord(receipt.promotion) ||
    !isJsonRecord(receipt.promotion.pr) ||
    !Number.isSafeInteger(receipt.promotion.pr.number) ||
    receipt.autoEnabled !== false
  ) {
    throw new CliError("Skill promotion did not confirm a separate pending CI PR.", 75);
  }
  console.log(
    "Created independent, CI-gated Skill catalog promotion PR #" + receipt.promotion.pr.number
  );
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
