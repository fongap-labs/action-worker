import {
  entriesFromLines,
  promoteEntries,
  promoteUnreleased,
  releaseSectionBody,
} from "./changelog-release.ts";
import {
  GithubReader,
  getGithubJson,
  getJsonArray,
  getJsonNumber,
  getJsonString,
  githubExists,
  isGithubMissing,
  isJsonRecord,
  type JsonRecord,
  runGithubCli,
} from "./github-api.ts";
import { assertTrustedMainWrite } from "./main-write-guard.ts";
import { CliError } from "./runtime-command.ts";

// Stage one of the two-phase release (AW-008): the central release assembles the changelog into a
// pull request, waits for it to pass the normal gate, and only then tags the merge commit.

export type ReleasePolicy = {
  changelog_file: string;
  changelog_fragment_dir: string;
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
  // The release's own entry lines (`<category>: <summary>`). When given, the release owns its
  // entries: it neither consumes [Unreleased] or the fragments nor removes them.
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

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
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

async function listFragments(
  options: ChangelogReleaseOptions
): Promise<Array<{ path: string; content: string; sha: string }>> {
  const { repository, baseSha, token, policy } = options;
  let listing: unknown[];
  try {
    listing = getJsonArray(
      await getGithubJson(
        `repos/${repository}/contents/${policy.changelog_fragment_dir}?ref=${baseSha}`,
        token
      )
    );
  } catch (error) {
    if (isGithubMissing(error)) {
      return [];
    }
    throw error;
  }
  const fragments: Array<{ path: string; content: string; sha: string }> = [];
  for (const item of listing) {
    if (
      !isJsonRecord(item) ||
      item.type !== "file" ||
      !getJsonString(item, "name").endsWith(".md")
    ) {
      continue;
    }
    const path = getJsonString(item, "path");
    const file = await readFileAt(repository, path, baseSha, token);
    if (file) {
      fragments.push({ path, ...file });
    }
  }
  return fragments.sort((left, right) => left.path.localeCompare(right.path));
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

// Writes the release branch: the assembled changelog, then the removal of every fragment it
// releases, then the pull request. Each step is a separate commit made through the contents API.
// A release that owns its entries writes only its own version section and removes nothing.
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
  const fragments = owned ? [] : await listFragments(options);
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
        fragments: fragments.map((fragment) => fragment.content),
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
  for (const fragment of fragments) {
    await runGithubCli(
      [
        "api",
        "--method",
        "DELETE",
        `repos/${repository}/contents/${fragment.path}`,
        "-f",
        `message=${message}`,
        "-f",
        `sha=${fragment.sha}`,
        "-f",
        `branch=${branch}`,
      ],
      token
    );
  }
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
          : "It assembles the unreleased entries and the fragments into the version section."
      }`,
    ],
    token
  );
  return getJsonNumber(JSON.parse(created) as unknown, "number");
}

async function validateMergeState(
  repository: string,
  sha: string,
  token: string
): Promise<"success" | "failure" | "pending"> {
  const status = await getGithubJson(`repos/${repository}/commits/${sha}/status`, token);
  const gate = getJsonArray(status, "statuses").find(
    (item) => isJsonRecord(item) && getJsonString(item, "context") === "validate-merge"
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
    if (pull && isJsonRecord(pull) && pull.merged === true) {
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
    const gate = await validateMergeState(repository, head, token);
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

// The tag is created only after the merge commit carries Main Write Guard proof. That proof comes
// from the target repository's own intake, which runs after the merge, so this waits for it.
// assertTrustedMainWrite itself polls for about a minute, so this allows about half an hour.
const MAIN_WRITE_GUARD_ATTEMPTS = 30;

async function waitForMainWriteGuard(options: ChangelogReleaseOptions, mergeSha: string) {
  const reader = new GithubReader(
    process.env.GITHUB_API_URL ?? "https://api.github.com",
    options.token
  );
  for (let attempt = 1; attempt <= MAIN_WRITE_GUARD_ATTEMPTS; attempt += 1) {
    try {
      await assertTrustedMainWrite(reader, options.repository, mergeSha, true);
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        attempt === MAIN_WRITE_GUARD_ATTEMPTS ||
        /failed Main Write Guard|validate-merge/.test(message)
      ) {
        throw error;
      }
    }
  }
}

export async function publishChangelogRelease(
  options: ChangelogReleaseOptions
): Promise<ChangelogRelease> {
  const { repository, tag, policy, token } = options;
  const branch = releaseBranchOf(tag);
  const pollMs = (options.pollSeconds ?? 20) * 1000;
  const deadline = Date.now() + (options.timeoutMinutes ?? 30) * 60_000;

  const pull = await findReleasePullRequest(repository, branch, token);
  let number = pull ? getJsonNumber(pull, "number") : await openReleasePullRequest(options, branch);
  for (let rebuilds = 0; ; rebuilds += 1) {
    try {
      const mergeSha = await waitForMerge(options, number, pollMs, deadline);
      await waitForMainWriteGuard(options, mergeSha);

      const changelog = await readFileAt(repository, policy.changelog_file, mergeSha, token);
      if (!changelog) {
        throw new CliError(
          `::error::${repository} has no ${policy.changelog_file} at ${mergeSha}.`,
          65
        );
      }
      return {
        mergeSha,
        notes: releaseSectionBody(changelog.content, options.releaseUrl),
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
