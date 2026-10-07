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

const DECISIVE_REVIEW_STATES = new Set(["APPROVED", "CHANGES_REQUESTED", "DISMISSED"]);

// Dependabot is a GitHub App, so no account can register this login.
const DEPENDENCY_BOT_LOGIN = "dependabot[bot]";

// Written as the PR Governance description while a pull request waits for approval; central
// intake reads it back and stops re-dispatching until an approval of the head commit exists.
export const AWAITING_APPROVAL_DESCRIPTION =
  "Awaiting maintainer approval of the current head commit";

export type PrTrustDecision = {
  trusted: boolean;
  basis: "author" | "approval" | "dependency-bot" | "none";
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

// A pull request may run change code centrally when its author is trusted, or when a trusted
// reviewer other than the author approved the exact head commit. Approval never carries over to
// a later push because it is bound to the reviewed commit.
export function evaluatePrTrust(
  pull: unknown,
  reviews: readonly unknown[],
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

  // Reviews arrive in submission order; each reviewer's latest decisive review on the head wins.
  const author = login(pull.user);
  const latestByReviewer = new Map<string, string>();
  for (const review of reviews) {
    if (!isJsonRecord(review)) continue;
    const reviewer = login(review.user);
    const state = getJsonString(review, "state");
    if (
      !reviewer ||
      reviewer === author ||
      getJsonString(review, "commit_id") !== expectedHeadSha ||
      !TRUSTED_ASSOCIATIONS.has(getJsonString(review, "author_association").toUpperCase()) ||
      !DECISIVE_REVIEW_STATES.has(state)
    ) {
      continue;
    }
    latestByReviewer.set(reviewer, state);
  }
  const approved = [...latestByReviewer.values()].includes("APPROVED");
  return { trusted: approved, basis: approved ? "approval" : "none", association };
}

export async function listPullReviews(
  reader: { get(path: string): Promise<unknown> },
  repository: string,
  prNumber: number | string
): Promise<unknown[]> {
  const reviews: unknown[] = [];
  for (let page = 1; page <= 20; page += 1) {
    const rows = getJsonArray(
      await reader.get(`repos/${repository}/pulls/${prNumber}/reviews?per_page=100&page=${page}`)
    );
    reviews.push(...rows);
    if (rows.length < 100) {
      return reviews;
    }
  }
  throw new CliError("PR review list exceeds the supported pagination limit.", 65);
}

async function main(): Promise<void> {
  const [repository = "", prNumber = "", expectedHeadSha = ""] = process.argv.slice(2);
  const token = process.env.GH_TOKEN ?? "";
  if (!repositoryPattern.test(repository) || !/^[1-9]\d*$/.test(prNumber) || !token) {
    throw new CliError("Usage: pr-trust.ts <repository> <pr-number> <expected-head-sha>", 64);
  }

  const reader = { get: (path: string) => getGithubJson(path, token) };
  const pull = await reader.get(`repos/${repository}/pulls/${prNumber}`);
  const decision = evaluatePrTrust(
    pull,
    await listPullReviews(reader, repository, prNumber),
    expectedHeadSha
  );
  await appendLines(process.env.GITHUB_OUTPUT, [
    `trusted=${decision.trusted}`,
    `basis=${decision.basis}`,
  ]);
  console.log(JSON.stringify(decision));
  // PR Governance reports an untrusted head as awaiting approval and stops there. Every other
  // caller, including the Central CI that executes change code, keeps failing closed.
  if (!decision.trusted && process.env.PR_TRUST_UNTRUSTED === "report") {
    console.log(
      `::notice::${repository}#${prNumber} is from an author without write access (${decision.association || "NONE"}). ` +
        "Central CI starts after a maintainer approves the current head commit."
    );
    return;
  }
  if (!decision.trusted) {
    throw new CliError(
      `::error::${repository}#${prNumber} is from an author without write access (${decision.association || "NONE"}). ` +
        "Central CI runs its code only after a maintainer approves the current head commit; approve it, then re-run this workflow.",
      77
    );
  }
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
