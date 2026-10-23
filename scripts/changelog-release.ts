import { CliError } from "./runtime-command.ts";
import { containsHan } from "./validate-engineering-language.ts";

// CHANGELOG entries and release sections (CHANGELOG_CONVENTIONS §4-§9).
// An entry reads `- <category>[ [<attribute>, ...]]: <summary>`. The category is one of the six
// Chinese categories in release.json, and the summary is Chinese text.

export type ChangelogEntry = {
  category: string;
  attributes: string[];
  summary: string;
};

const ENTRY_LINE = /^- ([^\s[\]:]+)(?: \[([^\]]+)\])?: (.+)$/;

// Mojibake from a UTF-8 file read as Windows-1252 (for example `â€“` for an en dash), or a
// replacement character. Such text is not English and not Chinese; the gate must refuse it.
const MOJIBAKE = /�|â€|â–|Â[ -¿]/;

export function parseEntry(line: string): ChangelogEntry | null {
  const match = ENTRY_LINE.exec(line);
  if (!match) return null;
  return {
    category: match[1] ?? "",
    attributes: (match[2] ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
    summary: match[3] ?? "",
  };
}

export function assertChineseSummary(summary: string): void {
  if (MOJIBAKE.test(summary)) {
    throw new CliError(
      `::error::CHANGELOG entry summary contains broken text: ${summary}. Re-type the characters instead of pasting converted text.`,
      65
    );
  }
  if (!containsHan(summary)) {
    throw new CliError(
      `::error::CHANGELOG entry summary must be Chinese text: ${summary}. English identifiers may stay inside the sentence.`,
      65
    );
  }
}

// Parses the entry lines of one source (the [Unreleased] section or one changelog fragment).
// Blank lines are skipped; any other line must be an entry in a permitted category.
export function parseEntries(
  text: string,
  categories: readonly string[],
  source: string
): ChangelogEntry[] {
  const entries: ChangelogEntry[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const entry = parseEntry(line);
    if (!entry) {
      throw new CliError(`::error::${source} holds a line that is not an entry: ${line}`, 65);
    }
    if (!categories.includes(entry.category)) {
      throw new CliError(`::error::${source} uses unknown category: ${entry.category}.`, 65);
    }
    entries.push(entry);
  }
  return entries;
}

export type PromoteOptions = {
  version: string;
  date: string;
  releaseUrl: string;
  categories: readonly string[];
  // Contents of the changelog fragments awaiting release, in the order they are assembled.
  fragments?: readonly string[];
};

// Moves every [Unreleased] entry and every pending fragment entry into one released version
// section. The version heading links to its GitHub Release, and the categories follow the order
// in release.json.
export function promoteUnreleased(content: string, options: PromoteOptions): string {
  const lines = content.split("\n");
  const start = lines.indexOf("## [Unreleased]");
  if (start === -1) {
    throw new CliError("::error::CHANGELOG must contain ## [Unreleased].", 65);
  }
  let end = lines.findIndex((line, index) => index > start && line.startsWith("## "));
  if (end === -1) end = lines.length;

  const entries = parseEntries(
    lines.slice(start + 1, end).join("\n"),
    options.categories,
    "[Unreleased]"
  );
  for (const fragment of options.fragments ?? []) {
    entries.push(...parseEntries(fragment, options.categories, "changelog fragment"));
  }
  if (entries.length === 0) {
    throw new CliError("::error::No CHANGELOG entries to release.", 65);
  }

  const release = [`## [${options.version}](${options.releaseUrl}) - ${options.date}`];
  for (const category of options.categories) {
    const items = entries.filter((entry) => entry.category === category);
    if (items.length === 0) continue;
    release.push("", `### ${category}`, "");
    for (const item of items) {
      const attributes = item.attributes.length > 0 ? ` [${item.attributes.join(", ")}]` : "";
      release.push(`-${attributes} ${item.summary}`);
    }
  }

  return [...lines.slice(0, start + 1), "", ...release, "", ...lines.slice(end)].join("\n");
}

// The heading a release adds: `## [version](release-url) - date`.
const RELEASE_HEADING = /^## \[([^\]]+)\]\((https:\/\/[^)\s]+)\) - (\d{4}-\d{2}-\d{2})$/;

export type ReleaseHeading = { version: string; releaseUrl: string; date: string };

export function releaseHeadingOf(line: string): ReleaseHeading | null {
  const match = RELEASE_HEADING.exec(line);
  if (!match) return null;
  return { version: match[1] ?? "", releaseUrl: match[2] ?? "", date: match[3] ?? "" };
}

// The body of one version section: the lines under its heading, up to the next version heading.
export function releaseSectionBody(content: string, version: string): string {
  const lines = content.split("\n");
  const start = lines.findIndex((line) => releaseHeadingOf(line)?.version === version);
  if (start === -1) {
    throw new CliError(`::error::CHANGELOG has no section for version ${version}.`, 65);
  }
  let end = lines.findIndex((line, index) => index > start && line.startsWith("## "));
  if (end === -1) end = lines.length;
  return lines
    .slice(start + 1, end)
    .join("\n")
    .trim();
}

export type ReleaseChangeInput = {
  baseChangelog: string;
  headChangelog: string;
  // Contents, at the base branch, of the fragments the release change removes.
  removedFragments: readonly string[];
  categories: readonly string[];
};

// A release pull request is accepted only when it is exactly what promoting the removed fragments
// and the unreleased entries produces. The version heading is read from the change itself, so
// the check cannot be satisfied by anything other than the entries it claims to release.
export function assertReleaseChange(input: ReleaseChangeInput): ReleaseHeading {
  const baseHeadings = new Set(input.baseChangelog.split(/\r?\n/));
  const added = input.headChangelog
    .split(/\r?\n/)
    .filter((line) => !baseHeadings.has(line))
    .map(releaseHeadingOf)
    .filter((heading): heading is ReleaseHeading => heading !== null);
  if (added.length !== 1) {
    throw new CliError(
      `::error::A release pull request must add exactly one version section; found ${added.length}.`,
      65
    );
  }
  const heading = added[0] as ReleaseHeading;
  const expected = promoteUnreleased(input.baseChangelog, {
    version: heading.version,
    date: heading.date,
    releaseUrl: heading.releaseUrl,
    categories: input.categories,
    fragments: input.removedFragments,
  });
  if (input.headChangelog.trimEnd() !== expected.trimEnd()) {
    throw new CliError(
      "::error::The release change does not match the unreleased entries and the fragments it removes.",
      65
    );
  }
  return heading;
}
