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

// The entries of every beta section of one formal version, oldest first. A beta section is written
// as `### category` groups of `- [attributes] summary` lines, which this reads back.
export function betaEntriesOf(
  content: string,
  version: string,
  categories: readonly string[]
): ChangelogEntry[] {
  if (version.includes("-")) return [];
  const sections: string[][] = [];
  let current: string[] | null = null;
  for (const line of content.split("\n")) {
    const heading = releaseHeadingOf(line);
    if (heading) {
      current = heading.version.startsWith(`${version}-beta.`) ? [] : null;
      if (current) sections.push(current);
    } else if (line.startsWith("## ")) {
      current = null;
    } else if (current) {
      current.push(line);
    }
  }
  // The newest section sits first in the file, so reverse to read the betas in release order.
  const entries: ChangelogEntry[] = [];
  for (const section of sections.reverse()) {
    let category = "";
    for (const line of section) {
      const group = /^### (.+)$/.exec(line);
      if (group) {
        category = group[1] ?? "";
        continue;
      }
      const item = /^-(?: \[([^\]]+)\])? (.+)$/.exec(line);
      if (item && categories.includes(category)) {
        entries.push({
          category,
          attributes: (item[1] ?? "")
            .split(",")
            .map((attribute) => attribute.trim())
            .filter(Boolean),
          summary: item[2] ?? "",
        });
      }
    }
  }
  return entries;
}

export type ReleaseSectionOptions = {
  version: string;
  date: string;
  releaseUrl: string;
  categories: readonly string[];
};

export type PromoteOptions = ReleaseSectionOptions & {
  // Contents of the changelog fragments awaiting release, in the order they are assembled.
  fragments?: readonly string[];
};

export type ScopedPromoteOptions = ReleaseSectionOptions & {
  // The release's own entries. A release that owns its entries takes nothing else.
  entries: readonly ChangelogEntry[];
};

// One version section: its heading, then the category groups in the order of release.json.
function renderRelease(
  entries: readonly ChangelogEntry[],
  options: ReleaseSectionOptions
): string[] {
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
  return release;
}

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

  // A formal release lists the entries of every beta of its version first, so no beta change is lost.
  const entries = betaEntriesOf(content, options.version, options.categories);
  entries.push(
    ...parseEntries(lines.slice(start + 1, end).join("\n"), options.categories, "[Unreleased]")
  );
  for (const fragment of options.fragments ?? []) {
    entries.push(...parseEntries(fragment, options.categories, "changelog fragment"));
  }
  if (entries.length === 0) {
    throw new CliError("::error::No CHANGELOG entries to release.", 65);
  }

  return [
    ...lines.slice(0, start + 1),
    "",
    ...renderRelease(entries, options),
    "",
    ...lines.slice(end),
  ].join("\n");
}

// Writes the version section of a release that owns its entries outright, such as a mirror of one
// upstream file. Unlike promoteUnreleased, the [Unreleased] entries and the fragments stay where
// they are: they belong to other releases, so this release never consumes them.
export function promoteEntries(content: string, options: ScopedPromoteOptions): string {
  const lines = content.split("\n");
  const start = lines.indexOf("## [Unreleased]");
  if (start === -1) {
    throw new CliError("::error::CHANGELOG must contain ## [Unreleased].", 65);
  }
  let end = lines.findIndex((line, index) => index > start && line.startsWith("## "));
  if (end === -1) end = lines.length;
  if (options.entries.length === 0) {
    throw new CliError("::error::No CHANGELOG entries to release.", 65);
  }

  const before = lines.slice(0, end);
  while (before.length > start + 1 && before[before.length - 1] === "") {
    before.pop();
  }
  return [...before, "", ...renderRelease(options.entries, options), "", ...lines.slice(end)].join(
    "\n"
  );
}

// Entry lines written in a manifest, each `<category>[ [<attribute>, ...]]: <summary>`, checked the
// same way as a fragment entry: a permitted category and a Chinese summary.
export function entriesFromLines(
  lines: readonly string[],
  categories: readonly string[]
): ChangelogEntry[] {
  const entries = lines.map((line) => {
    const entry = parseEntry(`- ${line}`);
    if (!entry) {
      throw new CliError(`::error::Changelog entry is not valid: ${line}`, 65);
    }
    if (!categories.includes(entry.category)) {
      throw new CliError(`::error::Changelog entry uses unknown category: ${entry.category}.`, 65);
    }
    assertChineseSummary(entry.summary);
    return entry;
  });
  if (entries.length === 0) {
    throw new CliError("::error::No CHANGELOG entries to release.", 65);
  }
  return entries;
}

// The entries of one version section read back from its category groups, as promoteEntries
// writes them. Any other line is refused.
export function entriesOfSection(body: string, categories: readonly string[]): ChangelogEntry[] {
  const entries: ChangelogEntry[] = [];
  let category = "";
  for (const line of body.split("\n")) {
    if (line.trim() === "") continue;
    const group = /^### (.+)$/.exec(line);
    if (group) {
      category = group[1] ?? "";
      if (!categories.includes(category)) {
        throw new CliError(`::error::Release section uses unknown category: ${category}.`, 65);
      }
      continue;
    }
    const item = /^-(?: \[([^\]]+)\])? (.+)$/.exec(line);
    if (!item || !categories.includes(category)) {
      throw new CliError(`::error::Release section holds a line that is not an entry: ${line}`, 65);
    }
    entries.push({
      category,
      attributes: (item[1] ?? "")
        .split(",")
        .map((attribute) => attribute.trim())
        .filter(Boolean),
      summary: item[2] ?? "",
    });
  }
  return entries;
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
// Sections are matched by their release URL, which names a unique tag; several tools may share a
// version number.
export function releaseSectionBody(content: string, releaseUrl: string): string {
  const lines = content.split("\n");
  const start = lines.findIndex((line) => releaseHeadingOf(line)?.releaseUrl === releaseUrl);
  if (start === -1) {
    throw new CliError(`::error::CHANGELOG has no section for ${releaseUrl}.`, 65);
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

// The one version section a release change adds. The heading is read from the change itself.
function addedReleaseHeading(baseChangelog: string, headChangelog: string): ReleaseHeading {
  const baseHeadings = new Set(baseChangelog.split(/\r?\n/));
  const added = headChangelog
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
  return added[0] as ReleaseHeading;
}

// A release pull request is accepted only when it is exactly what promoting the removed fragments
// and the unreleased entries produces. The version heading is read from the change itself, so
// the check cannot be satisfied by anything other than the entries it claims to release.
export function assertReleaseChange(input: ReleaseChangeInput): ReleaseHeading {
  const heading = addedReleaseHeading(input.baseChangelog, input.headChangelog);
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

export type ScopedReleaseChangeInput = {
  baseChangelog: string;
  headChangelog: string;
  categories: readonly string[];
};

// A release that owns its entries adds one version section and changes nothing else. The section
// must be exactly what promoteEntries writes from the entries it carries, so the summaries are
// checked as Chinese text and the section cannot carry a second release.
export function assertScopedReleaseChange(input: ScopedReleaseChangeInput): ReleaseHeading {
  const heading = addedReleaseHeading(input.baseChangelog, input.headChangelog);
  const entries = entriesOfSection(
    releaseSectionBody(input.headChangelog, heading.releaseUrl),
    input.categories
  );
  for (const entry of entries) {
    assertChineseSummary(entry.summary);
  }
  const expected = promoteEntries(input.baseChangelog, {
    version: heading.version,
    date: heading.date,
    releaseUrl: heading.releaseUrl,
    categories: input.categories,
    entries,
  });
  if (input.headChangelog.trimEnd() !== expected.trimEnd()) {
    throw new CliError(
      "::error::The scoped release change does not match the entries of its own section.",
      65
    );
  }
  return heading;
}
