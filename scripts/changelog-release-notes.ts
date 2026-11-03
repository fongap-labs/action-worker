import {
  entriesFromLines,
  promoteEntries,
  promoteUnreleased,
  releaseSectionBody,
} from "./changelog-release.ts";
import {
  getGithubJson,
  getJsonArray,
  getJsonString,
  isGithubMissing,
  isJsonRecord,
} from "./github-api.ts";
import { CliError } from "./runtime-command.ts";

// Release preparation is read-only. The source branch, changelog and fragments are never
// changed by a release. Only a normal code PR may update them.
export type ReleasePolicy = {
  changelog_file: string;
  changelog_fragment_dir: string;
  changelog_categories: string[];
};

export type ReleaseNotesOptions = {
  repository: string;
  baseSha: string;
  releaseKey: string;
  version: string;
  date: string;
  releaseUrl: string;
  policy: ReleasePolicy;
  token: string;
  entries?: readonly string[];
};

function decode(value: unknown): string {
  if (!isJsonRecord(value) || value.encoding !== "base64") {
    throw new CliError("GitHub returned a non-base64 changelog.", 65);
  }
  return Buffer.from(getJsonString(value, "content").replace(/\n/g, ""), "base64").toString("utf8");
}

async function readFileAt(
  repository: string,
  path: string,
  ref: string,
  token: string
): Promise<string | null> {
  try {
    return decode(
      await getGithubJson(
        `repos/${repository}/contents/${path}?ref=${encodeURIComponent(ref)}`,
        token
      )
    );
  } catch (error) {
    if (isGithubMissing(error)) return null;
    throw error;
  }
}

async function fragmentsAt(
  repository: string,
  path: string,
  ref: string,
  token: string
): Promise<Map<string, string>> {
  let items: unknown[];
  try {
    items = getJsonArray(
      await getGithubJson(
        `repos/${repository}/contents/${path}?ref=${encodeURIComponent(ref)}`,
        token
      )
    );
  } catch (error) {
    if (isGithubMissing(error)) return new Map();
    throw error;
  }
  const fragments = new Map<string, string>();
  for (const item of items) {
    if (!isJsonRecord(item) || item.type !== "file") continue;
    const name = getJsonString(item, "name");
    const fragmentPath = getJsonString(item, "path");
    if (!name.endsWith(".md") || !fragmentPath) continue;
    const content = await readFileAt(repository, fragmentPath, ref, token);
    if (content !== null) fragments.set(fragmentPath, content);
  }
  return fragments;
}

function unreleasedBounds(changelog: string): { lines: string[]; start: number; end: number } {
  const lines = changelog.split("\n");
  const start = lines.indexOf("## [Unreleased]");
  if (start < 0) throw new CliError("CHANGELOG must contain ## [Unreleased].", 65);
  let end = lines.findIndex((line, index) => index > start && line.startsWith("## "));
  if (end < 0) end = lines.length;
  return { lines, start, end };
}

// With no changelog commit during publication, old [Unreleased] lines remain in git.
// Subtract the already-published snapshot so later releases do not repeat those notes.
export function newUnreleasedLines(current: string, previous: string | null): string[] {
  const now = unreleasedBounds(current);
  const before =
    previous === null
      ? []
      : (() => {
          const old = unreleasedBounds(previous);
          return old.lines.slice(old.start + 1, old.end).filter((line) => line.trim() !== "");
        })();
  const counts = new Map<string, number>();
  for (const line of before) counts.set(line, (counts.get(line) ?? 0) + 1);
  const result: string[] = [];
  for (const line of now.lines.slice(now.start + 1, now.end)) {
    if (!line.trim()) continue;
    const count = counts.get(line) ?? 0;
    if (count > 0) counts.set(line, count - 1);
    else result.push(line);
  }
  return result;
}

function withUnreleasedLines(current: string, entries: readonly string[]): string {
  const { lines, start, end } = unreleasedBounds(current);
  return [...lines.slice(0, start + 1), "", ...entries, "", ...lines.slice(end)].join("\n");
}

function versionParts(version: string): number[] {
  return version.split(".").map((part) => Number(part));
}

function olderThan(left: string, right: string): boolean {
  const l = versionParts(left);
  const r = versionParts(right);
  for (let i = 0; i < 3; i += 1) {
    if ((l[i] ?? 0) !== (r[i] ?? 0)) return (l[i] ?? 0) < (r[i] ?? 0);
  }
  return false;
}

async function lastStableTag(options: ReleaseNotesOptions): Promise<string | null> {
  const prefix = `${options.releaseKey}-v`;
  const versions: string[] = [];
  for (let page = 1; page <= 3; page += 1) {
    const items = getJsonArray(
      await getGithubJson(
        `repos/${options.repository}/tags?per_page=100&page=${page}`,
        options.token
      )
    );
    for (const item of items) {
      const name = getJsonString(item, "name");
      const version = name.startsWith(prefix) ? name.slice(prefix.length) : "";
      if (/^\d+\.\d+\.\d+$/.test(version) && olderThan(version, options.version)) {
        versions.push(version);
      }
    }
    if (items.length < 100) break;
  }
  versions.sort((a, b) => (olderThan(a, b) ? 1 : olderThan(b, a) ? -1 : 0));
  return versions[0] ? `${prefix}${versions[0]}` : null;
}

export async function prepareReleaseNotes(options: ReleaseNotesOptions): Promise<string> {
  const { repository, baseSha, policy, token, version, date, releaseUrl } = options;
  const current = await readFileAt(repository, policy.changelog_file, baseSha, token);
  if (current === null) {
    throw new CliError(`Missing ${policy.changelog_file} in ${repository}@${baseSha}.`, 65);
  }
  const shared = { version, date, releaseUrl, categories: policy.changelog_categories };
  if (options.entries !== undefined) {
    const snapshot = promoteEntries(current, {
      ...shared,
      entries: entriesFromLines(options.entries, policy.changelog_categories),
    });
    return releaseSectionBody(snapshot, releaseUrl);
  }

  const previousTag = await lastStableTag(options);
  const previous = previousTag
    ? await readFileAt(repository, policy.changelog_file, previousTag, token)
    : null;
  const currentFragments = await fragmentsAt(
    repository,
    policy.changelog_fragment_dir,
    baseSha,
    token
  );
  const previousFragments = previousTag
    ? await fragmentsAt(repository, policy.changelog_fragment_dir, previousTag, token)
    : new Map<string, string>();
  const newFragments = [...currentFragments]
    .filter(([path, body]) => previousFragments.get(path) !== body)
    .map(([, body]) => body);
  const snapshot = promoteUnreleased(
    withUnreleasedLines(current, newUnreleasedLines(current, previous)),
    { ...shared, fragments: newFragments }
  );
  return releaseSectionBody(snapshot, releaseUrl);
}
