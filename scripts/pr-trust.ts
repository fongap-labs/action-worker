import { getGithubJson, getJsonArray, getJsonString, isJsonRecord } from "./github-api.ts";
import { appendLines, CliError, handleError, isMain } from "./runtime-command.ts";

const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const shaPattern = /^[0-9a-f]{40}$/;

// Authors with write-level standing in the target repository.
export const TRUSTED_ASSOCIATIONS: ReadonlySet<string> = new Set([
  "OWNER",
  "MEMBER",
  "COLLABORATOR",
]);

// Dependabot is a GitHub App, so no account can register this login.
const DEPENDENCY_BOT_LOGIN = "dependabot[bot]";
const MANAGED_APP_LOGIN = "fongap-bot[bot]";

export type PrTrustDecision = {
  trusted: boolean;
  basis: "author" | "dependency-bot" | "managed-app" | "none";
  association: string;
};

function login(value: unknown): string {
  return isJsonRecord(value) ? getJsonString(value, "login").toLowerCase() : "";
}

function repositoryOf(side: unknown): Record<string, unknown> {
  return isJsonRecord(side) && isJsonRecord(side.repo) ? side.repo : {};
}

// Dependabot opens its pull requests from a branch of the target repository itself. In a public
// target its change code runs in the sandbox with no credential, so it does not wait for approval.
// A private target keeps the approval requirement because its sandbox holds a checkout token.
function isPublicDependencyBotPull(pull: Record<string, unknown>): boolean {
  const base = repositoryOf(pull.base);
  const baseName = getJsonString(base, "full_name");
  return (
    login(pull.user) === DEPENDENCY_BOT_LOGIN &&
    isJsonRecord(pull.user) &&
    getJsonString(pull.user, "type") === "Bot" &&
    base.private === false &&
    baseName !== "" &&
    getJsonString(repositoryOf(pull.head), "full_name") === baseName
  );
}

// fongap-bot is the named, organization-owned GitHub App identity. A same-repository
// PR authored by that exact Bot account already used a privileged App write path.
// This is not an endorsement of other bots or any fork: no independent reviewer
// is required before deterministic CI for our own App-authored code.
function isManagedAppPull(pull: Record<string, unknown>): boolean {
  const author = pull.user;
  const baseName = getJsonString(repositoryOf(pull.base), "full_name");
  return (
    login(author) === MANAGED_APP_LOGIN &&
    isJsonRecord(author) &&
    getJsonString(author, "type") === "Bot" &&
    /^fongap-labs\/[A-Za-z0-9_.-]+$/.test(baseName) &&
    getJsonString(repositoryOf(pull.head), "full_name") === baseName
  );
}

// Only repository writers and scoped organization bots can run code through central CI.
// External PR reviews are never interpreted as a second-person execution authorization.
export function evaluatePrTrust(
  pull: unknown,
  _reviews: readonly unknown[],
  expectedHeadSha: string
): PrTrustDecision {
  if (!shaPattern.test(expectedHeadSha)) {
    throw new CliError("Expected head SHA must be a full commit SHA.", 64);
  }
  if (!isJsonRecord(pull)) {
    throw new CliError("GitHub pull request response is invalid.", 65);
  }
  const head = isJsonRecord(pull.head) ? pull.head : {};
  if (getJsonString(head, "sha") !== expectedHeadSha) {
    throw new CliError("PR head changed before trust evaluation.", 75);
  }

  const association = getJsonString(pull, "author_association").toUpperCase();
  if (TRUSTED_ASSOCIATIONS.has(association)) {
    return { trusted: true, basis: "author", association };
  }
  if (isPublicDependencyBotPull(pull)) {
    return { trusted: true, basis: "dependency-bot", association };
  }
  if (isManagedAppPull(pull)) {
    return { trusted: true, basis: "managed-app", association };
  }

  return { trusted: false, basis: "none", association };
}

async function main(): Promise<void> {
  const [repository = "", prNumber = "", expectedHeadSha = ""] = process.argv.slice(2);
  const token = process.env.GH_TOKEN ?? "";
  if (!repositoryPattern.test(repository) || !/^[1-9]\d*$/.test(prNumber) || !token) {
    throw new CliError("Usage: pr-trust.ts <repository> <pr-number> <expected-head-sha>", 64);
  }

  const reader = { get: (path: string) => getGithubJson(path, token) };
  const pull = await reader.get(`repos/${repository}/pulls/${prNumber}`);
  const decision = evaluatePrTrust(pull, [], expectedHeadSha);
  await appendLines(process.env.GITHUB_OUTPUT, [
    `trusted=${decision.trusted}`,
    `basis=${decision.basis}`,
  ]);
  console.log(JSON.stringify(decision));
  // PR Governance records an explicit rejection; no review-based waiting or implicit grant.
  // Central CI also refuses code from an unauthorized author.
  if (!decision.trusted && process.env.PR_TRUST_UNTRUSTED === "report") {
    console.log(
      `::notice::${repository}#${prNumber} is from an author without write access (${decision.association || "NONE"}). ` +
        "Central CI remains blocked; only an authorized repository writer or the trusted organization bot may submit code."
    );
    return;
  }
  if (!decision.trusted) {
    throw new CliError(
      `::error::${repository}#${prNumber} is from an author without write access (${decision.association || "NONE"}). ` +
        "Central CI cannot run code from an unauthorized author; PR reviews do not override this policy.",
      77
    );
  }
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
