import { getJsonArray, getJsonString, isJsonRecord } from "./github-api.ts";
import { CliError } from "./runtime-command.ts";

// CHANGELOG_CONVENTIONS.md §1 lists the eleven permitted change types; a commit subject that uses
// another word is not a Conventional Commits title. §2 defines breaking as an attribute, so the
// `!` marker and the "BREAKING CHANGE" footer fold into it, the only attribute a commit carries.
const COMMIT_SUBJECT =
  /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(?:\([A-Za-z0-9._/ -]{1,64}\))?(!)?:\s+(.+)$/;

const BREAKING_FOOTER = /BREAKING[- ]CHANGE:/;

// The squash title carries the PR reference; release notes describe the change, not the pull.
const PR_REFERENCE = /\s*\(#\d+\)\s*$/;

/** Merge subjects skip the classification; the governance gate owns PR title enforcement. */
export function isMergeSubject(subject: string): boolean {
  return /^Merge (pull request|remote-tracking branch|branch) /i.test(subject);
}

export type CommitChange = {
  type: string;
  attributes: string[];
  summary: string;
};

/**
 * Reads one commit message as a change record. A subject that is not a Conventional Commits title
 * under CHANGELOG_CONVENTIONS.md §3 returns null; the caller decides how strict to be, so the
 * module tests can also cover a permissive pass-through.
 */
export function classifyCommit(message: string): CommitChange | null {
  const subject = (message.split("\n", 1)[0] ?? "").trim();
  const match = COMMIT_SUBJECT.exec(subject);
  if (!match) {
    return null;
  }
  const attributes: string[] = [];
  if (match[2] === "!") {
    attributes.push("breaking");
  }
  if (BREAKING_FOOTER.test(message) && !attributes.includes("breaking")) {
    attributes.push("breaking");
  }
  return {
    type: match[1] ?? "",
    attributes,
    summary: (match[3] ?? "").replace(PR_REFERENCE, "").trim(),
  };
}

// The smallest bump the span reaches; null means nothing release-worthy changed.
export type ReleaseBump = "major" | "minor" | "patch" | null;

const BUMP_WEIGHT: Record<Exclude<ReleaseBump, null>, number> = {
  patch: 1,
  minor: 2,
  major: 3,
};

function strongestBump(left: ReleaseBump, right: ReleaseBump): ReleaseBump {
  if (left === null) return right;
  if (right === null) return left;
  return BUMP_WEIGHT[left] >= BUMP_WEIGHT[right] ? left : right;
}

/**
 * Chooses the version bump a span of changes requires. CHANGELOG_CONVENTIONS.md leaves the version
 * to the release launch input, so the result only proposes a value for that input.
 */
export function bumpForChanges(
  changes: readonly { type: string; attributes: string[] }[]
): ReleaseBump {
  let bump: ReleaseBump = null;
  for (const change of changes) {
    if (change.attributes.includes("breaking")) {
      bump = strongestBump(bump, "major");
    } else if (change.type === "feat") {
      bump = strongestBump(bump, "minor");
    } else if (
      change.type === "fix" ||
      change.type === "perf" ||
      change.type === "revert" ||
      change.attributes.length > 0
    ) {
      bump = strongestBump(bump, "patch");
    }
  }
  return bump;
}

const BUMP_INDEX: Record<Exclude<ReleaseBump, null>, number> = {
  major: 3,
  minor: 2,
  patch: 1,
};

/**
 * Applies one bump to a stable SemVer base. SemVer 0.x keeps breaking changes inside the minor
 * number, so a major bump on a 0.x base becomes a minor bump. A missing base (no release yet)
 * grows 0.0.0 into the smallest change the span shows.
 */
export function nextVersion(base: string | undefined, bump: Exclude<ReleaseBump, null>): string {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(base ?? "0.0.0");
  if (!match) {
    throw new CliError(`The release tag carried a non-stable version base: '${base}'.`, 65);
  }
  const major = Number(match[1] ?? 0);
  const minor = Number(match[2] ?? 0);
  const patch = Number(match[3] ?? 0);
  if (major === 0) {
    if (BUMP_INDEX[bump] >= 2) {
      return `0.${minor + 1}.0`;
    }
    return `0.${minor}.${patch + 1}`;
  }
  if (BUMP_INDEX[bump] >= 3) {
    return `${major + 1}.0.0`;
  }
  if (BUMP_INDEX[bump] === 2) {
    return `${major}.${minor + 1}.0`;
  }
  return `${major}.${minor}.${patch + 1}`;
}

type CommitRecord = {
  sha: string;
  message: string;
};

function asCommitRecord(value: unknown): CommitRecord | null {
  if (!isJsonRecord(value) || typeof value.sha !== "string" || !/^[0-9a-f]{40}$/.test(value.sha)) {
    return null;
  }
  const commit = isJsonRecord(value.commit) ? value.commit : {};
  const message = typeof commit.message === "string" ? commit.message : "";
  return { sha: value.sha, message };
}

/** Reads commits out of a compare endpoint response, keeping the API order (newest first). */
export function commitRecordsFromCompare(compare: unknown): CommitRecord[] {
  const records: CommitRecord[] = [];
  for (const commit of getJsonArray(compare, "commits")) {
    const record = asCommitRecord(commit);
    if (record) {
      records.push(record);
    }
  }
  const total =
    isJsonRecord(compare) && typeof compare.total_commits === "number" ? compare.total_commits : 0;
  if (total > records.length) {
    throw new CliError(
      `The commit span holds ${total} commits, more than one compare response returns. Enter an explicit requested_version instead.`,
      65
    );
  }
  return records;
}

/** Reads commit-list endpoints of the same shape (newest first) with a hard record budget. */
export function commitRecordsFromList(pages: readonly unknown[]): CommitRecord[] {
  const records: CommitRecord[] = [];
  for (const page of pages) {
    for (const commit of getJsonArray(page)) {
      const record = asCommitRecord(commit);
      if (record) {
        records.push(record);
      }
    }
  }
  if (records.length > 300) {
    throw new CliError(
      `The commit span holds ${records.length} commits, more than the span reader accepts. Enter an explicit requested_version instead.`,
      65
    );
  }
  return records;
}

/**
 * Turns raw commit messages into change records. A commit that is neither a Conventional Commits
 * title nor a merge fails closed: CHANGELOG_CONVENTIONS.md §3 governs PR titles, and the release
 * must not paper over a governance gap by bumping a version it cannot explain.
 */
export function changesFromSpan(records: readonly CommitRecord[]): CommitChange[] {
  const changes: CommitChange[] = [];
  const offendingSubjects: string[] = [];
  for (const record of records) {
    const change = classifyCommit(record.message);
    if (change) {
      changes.push(change);
      continue;
    }
    const subject = record.message.split("\n", 1)[0] ?? "";
    if (isMergeSubject(subject)) {
      continue;
    }
    offendingSubjects.push(subject.slice(0, 200));
  }
  if (offendingSubjects.length > 0) {
    throw new CliError(
      `Commit subjects are not Conventional Commits titles (CHANGELOG_CONVENTIONS.md §3): ${offendingSubjects.join(" | ")}. Cut a new pull request with the corrected title, or enter an explicit requested_version.`,
      65
    );
  }
  return changes;
}

export type SpanReader = {
  get(path: string): Promise<unknown>;
};

export type LoadReleaseSpanOptions = {
  // The version tags live where the release is published.
  target_repository: string;
  source_repository: string;
  source_sha: string;
  default_branch: string;
  release_key: string;
  // When the product lives under a directory, only commits touching its tree belong to it.
  root: string;
  // Fetches the changed file paths of one commit; defaults to the commits API.
  filesForCommit?: (sha: string) => Promise<string[]>;
};

export type ReleaseSpan = {
  base_version: string | undefined;
  changes: CommitChange[];
};

function releasedVersions(tagNames: readonly string[], releaseKey: string): string[] {
  const pattern = new RegExp(`^${releaseKey}-v(\\d+\\.\\d+\\.\\d+)$`);
  const versions: string[] = [];
  for (const name of tagNames) {
    const match = pattern.exec(name);
    if (match?.[1]) {
      versions.push(match[1]);
    }
  }
  return versions;
}

function greatestVersion(versions: readonly string[]): string | undefined {
  const numeric = (version: string): number[] =>
    version.split(".").map((part) => Number(part) || 0);
  const sorted = [...versions].sort((left, right) => {
    const [a = 0, b = 0, c = 0] = numeric(left);
    const [x = 0, y = 0, z = 0] = numeric(right);
    return a !== x ? x - a : b !== y ? y - b : z - c;
  });
  return sorted[0];
}

function defaultFilesFor(
  reader: SpanReader,
  repository: string
): (sha: string) => Promise<string[]> {
  return async (sha: string) => {
    const commit = await reader.get(`repos/${repository}/commits/${sha}`);
    return getJsonArray(commit, "files")
      .map((file) => (isJsonRecord(file) ? getJsonString(file, "filename") : ""))
      .filter(Boolean);
  };
}

function touchesProductRoot(files: readonly string[], root: string): boolean {
  return files.some((file) => file === root || file.startsWith(`${root}/`));
}

/**
 * Loads the release span of one release key at one source commit: the last published version of
 * the release key carries the span base, and the commits after it carry the changes. A product
 * root needs the files of each commit to decide what belongs to the product, so the span stays
 * bounded: a span that needs more than fifty commit-detail reads asks for an explicit version.
 */
export async function loadReleaseSpan(
  reader: SpanReader,
  options: LoadReleaseSpanOptions
): Promise<ReleaseSpan> {
  const tagNames: string[] = [];
  for (let page = 1; page <= 3; page += 1) {
    const response = await reader.get(
      `repos/${options.target_repository}/tags?per_page=100&page=${page}`
    );
    const names = getJsonArray(response)
      .map((entry) => (isJsonRecord(entry) ? getJsonString(entry, "name") : ""))
      .filter(Boolean);
    tagNames.push(...names);
    if (names.length < 100) {
      break;
    }
  }
  const baseVersion = greatestVersion(releasedVersions(tagNames, options.release_key));

  const collect = async (): Promise<CommitRecord[]> => {
    if (baseVersion) {
      const baseTag = `${options.release_key}-v${baseVersion}`;
      const tagCommit = await reader.get(
        `repos/${options.source_repository}/commits/${encodeURIComponent(baseTag)}`
      );
      const baseTagSha = getJsonString(tagCommit, "sha");
      if (!/^[0-9a-f]{40}$/.test(baseTagSha)) {
        throw new CliError(
          `The published release tag did not resolve to a commit: ${baseTag} in ${options.source_repository}.`,
          65
        );
      }
      const compare = await reader.get(
        `repos/${options.source_repository}/compare/${baseTagSha}...${options.source_sha}`
      );
      return commitRecordsFromCompare(compare);
    }
    const pages: unknown[] = [];
    for (let page = 1; page <= 3; page += 1) {
      const response = await reader.get(
        `repos/${options.source_repository}/commits?sha=${encodeURIComponent(options.default_branch)}&per_page=100&page=${page}`
      );
      pages.push(response);
      if (getJsonArray(response).length < 100) {
        break;
      }
    }
    return commitRecordsFromList(pages);
  };

  if (options.root === "") {
    return { base_version: baseVersion, changes: changesFromSpan(await collect()) };
  }

  const records = await collect();
  if (records.length > 50) {
    throw new CliError(
      `The commit span holds ${records.length} commits, more than the product-root filter reads. Enter an explicit requested_version instead.`,
      65
    );
  }
  const filesFor = options.filesForCommit ?? defaultFilesFor(reader, options.source_repository);
  const scoped: CommitRecord[] = [];
  for (const record of records) {
    const files = await filesFor(record.sha);
    if (touchesProductRoot(files, options.root)) {
      scoped.push(record);
    }
  }
  return { base_version: baseVersion, changes: changesFromSpan(scoped) };
}
