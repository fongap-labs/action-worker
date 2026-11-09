import {
  assertReleaseChange,
  entriesFromLines,
  entriesOfSection,
  promoteEntries,
  promoteUnreleased,
  releaseHeadingOf,
  releaseSectionBody,
} from "./changelog-release.ts";
import {
  getGithubJson,
  getJsonArray,
  getJsonNumber,
  getJsonString,
  githubExists,
  isGithubMissing,
  isJsonRecord,
  type JsonRecord,
  runGithubCli,
  statusAwareReader,
} from "./github-api.ts";
import { assertTrustedMainWrite } from "./main-write-guard.ts";
import { CliError } from "./runtime-command.ts";
import { hasValidStatusAttestation } from "./status-attestation.ts";

// Stage one of the two-phase release (AW-008): the central release assembles the changelog into a
// pull request, waits for it to pass the normal gate, and only then tags the merge commit.

export type ReleasePolicy = {
  changelog_file: string;
  changelog_categories: string[];
};

export type ChangelogReleaseOptions = {
  repository: string;
  defaultBranch: string;
  baseSha: string;
  tag: string;
  version: string;
  date: string;
  releaseUrl: string;
  policy: ReleasePolicy;
  token: string;
  statusToken: string;
  // The release's own entry lines (`<category>: <summary>`). When given, the release owns its
  // entries: it never consumes shared [Unreleased] entries.
  entries?: readonly string[];
  pollSeconds?: number;
  timeoutMinutes?: number;
};

export type ChangelogRelease = {
  mergeSha: string;
  notes: string;
};

export function releaseBranchOf(tag: string): string {
  return `aw/changelog/${tag}`;
}

export function releasePullRequestTitle(tag: string): string {
  return `chore(release): ${tag}`;
}

/**
 * A prior release branch/PR is only a resumable operation if it still belongs
 * to this target, base and release tag. A signed main guard proves provenance
 * of a merge, but not that the merge belongs to the requested release.
 */
export function assertReleasePullRequestIdentity(
  pull: unknown,
  options: Pick<ChangelogReleaseOptions, "repository" | "defaultBranch" | "tag">
): void {
  const head = isJsonRecord(pull) && isJsonRecord(pull.head) ? pull.head : null;
  const base = isJsonRecord(pull) && isJsonRecord(pull.base) ? pull.base : null;
  const headRepo = head && isJsonRecord(head.repo) ? head.repo : null;
  const baseRepo = base && isJsonRecord(base.repo) ? base.repo : null;
  if (
    !isJsonRecord(pull) ||
    typeof pull.number !== "number" ||
    !Number.isSafeInteger(pull.number) ||
    pull.number < 1 ||
    pull.title !== releasePullRequestTitle(options.tag) ||
    head?.ref !== releaseBranchOf(options.tag) ||
    headRepo?.full_name !== options.repository ||
    base?.ref !== options.defaultBranch ||
    baseRepo?.full_name !== options.repository ||
    pull.draft === true
  ) {
    throw new CliError(
      "::error::Existing release PR identity does not match the approved repository, branch and tag. Inspect it before retrying.",
      65
    );
  }
}

/**
 * A resumed PR is not proven to belong to the current manifest by its title
 * alone. Verify the merged changelog version and scoped entries before a tag
 * may point at the merge commit.
 */
export function assertMergedReleaseSection(
  changelog: string,
  options: Pick<ChangelogReleaseOptions, "version" | "releaseUrl" | "policy" | "entries">
): string {
  const headings = changelog
    .split("\n")
    .map(releaseHeadingOf)
    .filter((heading) => heading?.releaseUrl === options.releaseUrl);
  if (headings.length !== 1 || headings[0]?.version !== options.version) {
    throw new CliError(
      "::error::Merged Release section does not uniquely match the requested version and tag.",
      65
    );
  }
  const notes = releaseSectionBody(changelog, options.releaseUrl);
  const actual = entriesOfSection(notes, options.policy.changelog_categories);
  if (actual.length === 0) {
    throw new CliError("::error::Merged Release section contains no verified entries.", 65);
  }
  if (options.entries !== undefined) {
    const declared = entriesFromLines(options.entries, options.policy.changelog_categories);
    const expected = options.policy.changelog_categories.flatMap((category) =>
      declared.filter((entry) => entry.category === category)
    );
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new CliError(
        "::error::Merged Release section differs from this request's manifest entries.",
        65
      );
    }
  }
  return notes;
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

/** Invalid timing configuration must fail before any release PR or branch mutation. */
export function releaseStageTiming(
  options: Pick<ChangelogReleaseOptions, "pollSeconds" | "timeoutMinutes">,
  now = Date.now()
): { pollMs: number; deadline: number } {
  const pollSeconds = options.pollSeconds ?? 20;
  const timeoutMinutes = options.timeoutMinutes ?? 30;
  if (
    !Number.isInteger(pollSeconds) ||
    pollSeconds < 1 ||
    pollSeconds > 120 ||
    !Number.isInteger(timeoutMinutes) ||
    timeoutMinutes < 1 ||
    timeoutMinutes > 30 ||
    !Number.isFinite(now)
  ) {
    throw new CliError("::error::Release poll and timeout settings are invalid.", 64);
  }
  return { pollMs: pollSeconds * 1000, deadline: now + timeoutMinutes * 60_000 };
}

/** A release may not proceed to any publish-changing step after its approved window. */
export function assertReleaseStageDeadline(deadline: number, now = Date.now()): void {
  if (!Number.isFinite(deadline) || !Number.isFinite(now) || now >= deadline) {
    throw new CliError(
      "::error::Two-phase release deadline expired. The existing PR is retained for controlled resumption; no tag or Release may be created by this attempt.",
      75
    );
  }
}

function encode(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

function decode(json: unknown): string {
  return Buffer.from(getJsonString(json, "content").replace(/\n/g, ""), "base64").toString("utf8");
}

async function readFileAt(
  repository: string,
  path: string,
  ref: string,
  token: string
): Promise<{ content: string; sha: string } | null> {
  try {
    const json = await getGithubJson(`repos/${repository}/contents/${path}?ref=${ref}`, token);
    return { content: decode(json), sha: getJsonString(json, "sha") };
  } catch (error) {
    if (isGithubMissing(error)) {
      return null;
    }
    throw error;
  }
}

// Do not silently lose pending entries from repositories that have not migrated.
async function ensureNoLegacyFragments(
  repository: string,
  baseSha: string,
  token: string
): Promise<void> {
  try {
    const entries = getJsonArray(
      await getGithubJson(`repos/${repository}/contents/changelog.d?ref=${baseSha}`, token)
    );
    if (
      entries.some(
        (item) =>
          isJsonRecord(item) && item.type === "file" && getJsonString(item, "name").endsWith(".md")
      )
    ) {
      throw new CliError(
        "::error::Legacy changelog.d entries remain. Move them to CHANGELOG.md in a governed PR before release.",
        65
      );
    }
  } catch (error) {
    if (isGithubMissing(error)) return;
    throw error;
  }
}

async function findReleasePullRequest(
  repository: string,
  branch: string,
  token: string
): Promise<JsonRecord | null> {
  const owner = repository.split("/")[0] ?? "";
  const pulls = getJsonArray(
    await getGithubJson(
      `repos/${repository}/pulls?state=all&per_page=20&head=${owner}:${branch}`,
      token
    )
  );
  const found = pulls.find(isJsonRecord);
  return found ?? null;
}

/**
 * A same-repository stage-one squash merge can make the original trusted source
 * SHA stale. Only a direct one-commit, CHANGELOG-only successor is eligible for
 * resumability. API omissions, unrelated commits and extra files fail closed.
 */
export function isExactChangelogResumeDiff(
  comparison: unknown,
  sourceSha: string,
  mergeSha: string,
  changelogFile: string
): boolean {
  const baseCommit = getJsonRecord(comparison, "base_commit");
  const commits = getJsonArray(comparison, "commits");
  const files = getJsonArray(comparison, "files");
  return (
    getJsonString(comparison, "status") === "ahead" &&
    getJsonNumber(comparison, "ahead_by") === 1 &&
    getJsonNumber(comparison, "behind_by") === 0 &&
    getJsonString(baseCommit, "sha") === sourceSha &&
    commits.length === 1 &&
    getJsonString(commits[0], "sha") === mergeSha &&
    files.length === 1 &&
    getJsonString(files[0], "filename") === changelogFile &&
    getJsonString(files[0], "status") === "modified"
  );
}

/**
 * Read-only proof required before relaxing freshness for a previously merged
 * staging Release. This MUST run before publishChangelogRelease may write any
 * new branch/PR. Both the trusted original source and current HEAD are pinned.
 */
export async function assertExactMergedChangelogResume(
  options: Pick<
    ChangelogReleaseOptions,
    "repository" | "defaultBranch" | "tag" | "version" | "releaseUrl" | "policy" | "token"
  > & { sourceSha: string; mergeSha: string }
): Promise<void> {
  const { repository, defaultBranch, tag, sourceSha, mergeSha, token, policy } = options;
  const pull = await findReleasePullRequest(repository, releaseBranchOf(tag), token);
  assertReleasePullRequestIdentity(pull, { repository, defaultBranch, tag });
  if (
    !isJsonRecord(pull) ||
    pull.merged !== true ||
    pull.state !== "closed" ||
    pull.merge_commit_sha !== mergeSha
  ) {
    throw new CliError(
      "::error::Stale source has no matching merged staging Release PR at the current default HEAD.",
      65
    );
  }
  const diff = await getGithubJson(
    `repos/${repository}/compare/${sourceSha}...${mergeSha}`,
    token
  );
  if (!isExactChangelogResumeDiff(diff, sourceSha, mergeSha, policy.changelog_file)) {
    throw new CliError(
      "::error::Stale source was not advanced exclusively by the approved staging changelog squash merge.",
      65
    );
  }
  const original = await readFileAt(repository, policy.changelog_file, sourceSha, token);
  const merged = await readFileAt(repository, policy.changelog_file, mergeSha, token);
  if (!original || !merged) {
    throw new CliError("::error::Pinned staging changelog history is not readable.", 65);
  }
  const promoted = assertReleaseChange({
    baseChangelog: original.content,
    headChangelog: merged.content,
    categories: policy.changelog_categories,
  });
  if (promoted.version !== options.version || promoted.releaseUrl !== options.releaseUrl) {
    throw new CliError(
      "::error::Merged staging changelog promotion does not match the requested Release.",
      65
    );
  }
  assertMergedReleaseSection(merged.content, options);
}

// Writes a single changelog version section on a release branch, then opens a pull request.
async function openReleasePullRequest(
  options: ChangelogReleaseOptions,
  branch: string
): Promise<number> {
  const { repository, baseSha, defaultBranch, tag, version, date, releaseUrl, policy, token } =
    options;
  const changelog = await readFileAt(repository, policy.changelog_file, baseSha, token);
  if (!changelog) {
    throw new CliError(`::error::${repository} has no ${policy.changelog_file}.`, 65);
  }
  const owned = options.entries !== undefined;
  if (!owned) await ensureNoLegacyFragments(repository, baseSha, token);
  const expected = owned
    ? promoteEntries(changelog.content, {
        version,
        date,
        releaseUrl,
        categories: policy.changelog_categories,
        entries: entriesFromLines(options.entries ?? [], policy.changelog_categories),
      })
    : promoteUnreleased(changelog.content, {
        version,
        date,
        releaseUrl,
        categories: policy.changelog_categories,
      });

  const message = releasePullRequestTitle(tag);
  // A branch without a pull request is left by an earlier attempt that failed; it is rebuilt.
  if (await githubExists(`repos/${repository}/git/ref/heads/${branch}`, token)) {
    await runGithubCli(
      ["api", "--method", "DELETE", `repos/${repository}/git/refs/heads/${branch}`],
      token
    );
  }
  await runGithubCli(
    [
      "api",
      "--method",
      "POST",
      `repos/${repository}/git/refs`,
      "-f",
      `ref=refs/heads/${branch}`,
      "-f",
      `sha=${baseSha}`,
    ],
    token
  );
  await runGithubCli(
    [
      "api",
      "--method",
      "PUT",
      `repos/${repository}/contents/${policy.changelog_file}`,
      "-f",
      `message=${message}`,
      "-f",
      `content=${encode(`${expected}\n`)}`,
      "-f",
      `sha=${changelog.sha}`,
      "-f",
      `branch=${branch}`,
    ],
    token
  );
  const created = await runGithubCli(
    [
      "api",
      "--method",
      "POST",
      `repos/${repository}/pulls`,
      "-f",
      `title=${message}`,
      "-f",
      `head=${branch}`,
      "-f",
      `base=${defaultBranch}`,
      "-f",
      `body=Automated changelog release for ${tag}. ${
        owned
          ? "It adds the version section of this release's own entries."
          : "It promotes the [Unreleased] entries into the version section."
      }`,
    ],
    token
  );
  return getJsonNumber(JSON.parse(created) as unknown, "number");
}

async function validateMergeState(
  repository: string,
  sha: string,
  statusToken: string
): Promise<"success" | "failure" | "pending"> {
  const status = await getGithubJson(`repos/${repository}/commits/${sha}/status`, statusToken);
  const gate = getJsonArray(status, "statuses").find(
    (item) =>
      isJsonRecord(item) &&
      getJsonString(item, "context") === "validate-merge" &&
      hasValidStatusAttestation(item, { repository, sha, context: "validate-merge" })
  );
  const state = isJsonRecord(gate) ? getJsonString(gate, "state") : "";
  if (state === "success") {
    return "success";
  }
  if (state === "failure" || state === "error") {
    return "failure";
  }
  return "pending";
}

// The release branch conflicts with the default branch because another release merged first. The
// branch is stale, not failed: it is rebuilt from the current head instead of waiting out the deadline.
class StaleReleaseBranch extends Error {}

// How many times a stale release section is rebuilt before the release fails.
const MAX_RELEASE_REBUILDS = 3;

// Waits for the pull request to pass its gate and merges it. A failed gate is re-read a few times
// first, because a newer gate run may still replace it. The pull request stays open on failure so
// that a rerun resumes it instead of opening another one.
async function waitForMerge(
  options: ChangelogReleaseOptions,
  number: number,
  pollMs: number,
  deadline: number
): Promise<string> {
  const { repository, token } = options;
  let failureReads = 0;
  while (Date.now() < deadline) {
    const pull = await getGithubJson(`repos/${repository}/pulls/${number}`, token);
    assertReleasePullRequestIdentity(pull, options);
    if (pull && isJsonRecord(pull) && pull.merged === true) {
      assertReleaseStageDeadline(deadline);
      return getJsonString(pull, "merge_commit_sha");
    }
    if (getJsonString(pull, "state") === "closed") {
      throw new CliError(
        `::error::Release pull request #${number} was closed without merging. Reopen it or delete ${releaseBranchOf(options.tag)} and rerun.`,
        65
      );
    }
    if (getJsonString(pull, "mergeable_state") === "dirty") {
      throw new StaleReleaseBranch(
        `Release pull request #${number} conflicts with ${repository}@${options.defaultBranch}.`
      );
    }
    const head = getJsonString(getJsonRecord(pull, "head"), "sha");
    const gate = await validateMergeState(repository, head, options.statusToken);
    if (gate === "failure") {
      failureReads += 1;
      if (failureReads >= 3) {
        throw new CliError(
          `::error::Release pull request #${number} failed the validate-merge check. It stays open for inspection.`,
          65
        );
      }
    } else {
      failureReads = 0;
    }
    if (gate === "success") {
      assertReleaseStageDeadline(deadline);
      if (getJsonString(pull, "mergeable_state") === "behind") {
        await runGithubCli(
          ["api", "--method", "PUT", `repos/${repository}/pulls/${number}/update-branch`],
          token
        ).catch(() => undefined);
      } else {
        await runGithubCli(
          [
            "api",
            "--method",
            "PUT",
            `repos/${repository}/pulls/${number}/merge`,
            "-f",
            "merge_method=squash",
            "-f",
            `sha=${head}`,
          ],
          token
        ).catch(() => undefined);
      }
    }
    await sleep(pollMs);
  }
  throw new CliError(
    `::error::Release pull request #${number} did not merge within the release deadline.`,
    65
  );
}

function getJsonRecord(value: unknown, key: string): unknown {
  return isJsonRecord(value) ? value[key] : undefined;
}

// The tag is created only after the merge commit carries Main Write Guard proof.
// The expensive attestation poll must share the SAME release deadline as the PR merge.
const MAIN_WRITE_GUARD_ATTEMPTS = 30;

async function waitForMainWriteGuard(
  options: ChangelogReleaseOptions,
  mergeSha: string,
  deadline: number
) {
  const reader = statusAwareReader(
    process.env.GITHUB_API_URL ?? "https://api.github.com",
    options.token,
    options.statusToken
  );
  for (let attempt = 1; attempt <= MAIN_WRITE_GUARD_ATTEMPTS; attempt += 1) {
    assertReleaseStageDeadline(deadline);
    try {
      await assertTrustedMainWrite(reader, options.repository, mergeSha, true);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        attempt === MAIN_WRITE_GUARD_ATTEMPTS ||
        /failed Main Write Guard|validate-merge/.test(message)
      ) {
        throw error;
      }
      continue;
    }
    assertReleaseStageDeadline(deadline);
    return;
  }
}

export async function publishChangelogRelease(
  options: ChangelogReleaseOptions
): Promise<ChangelogRelease> {
  const { repository, tag, policy, token } = options;
  const branch = releaseBranchOf(tag);
  const { pollMs, deadline } = releaseStageTiming(options);

  const pull = await findReleasePullRequest(repository, branch, token);
  if (pull) assertReleasePullRequestIdentity(pull, options);
  let number = pull ? getJsonNumber(pull, "number") : await openReleasePullRequest(options, branch);
  for (let rebuilds = 0; ; rebuilds += 1) {
    try {
      const mergeSha = await waitForMerge(options, number, pollMs, deadline);
      await waitForMainWriteGuard(options, mergeSha, deadline);
      assertReleaseStageDeadline(deadline);

      const changelog = await readFileAt(repository, policy.changelog_file, mergeSha, token);
      if (!changelog) {
        throw new CliError(
          `::error::${repository} has no ${policy.changelog_file} at ${mergeSha}.`,
          65
        );
      }
      assertReleaseStageDeadline(deadline);
      return {
        mergeSha,
        notes: assertMergedReleaseSection(changelog.content, options),
      };
    } catch (error) {
      if (!(error instanceof StaleReleaseBranch) || rebuilds >= MAX_RELEASE_REBUILDS) {
        throw error;
      }
      // Close the conflicting pull request and rebuild the section on the current default-branch
      // head. Each rebuild rereads the head, so it converges once no other release is in flight.
      await runGithubCli(
        ["api", "--method", "PATCH", `repos/${repository}/pulls/${number}`, "-f", "state=closed"],
        token
      );
      const head = getJsonString(
        await getGithubJson(`repos/${repository}/commits/${options.defaultBranch}`, token),
        "sha"
      );
      number = await openReleasePullRequest({ ...options, baseSha: head }, branch);
    }
  }
}
