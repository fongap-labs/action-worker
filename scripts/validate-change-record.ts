import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  assertChineseSummary,
  assertReleaseChange,
  assertScopedReleaseChange,
  parseEntry,
} from "./changelog-release.ts";
import { isJsonRecord } from "./github-api.ts";
import {
  appendLines,
  CliError,
  handleError,
  isMain,
  readJson,
  runText,
} from "./runtime-command.ts";
import { assertEnglishText } from "./validate-engineering-language.ts";

type ChangeRecord = {
  schema_version: "1";
  type: string;
  scope: string | null;
  attributes: string[];
  summary: string;
  changelog_required: boolean;
  changelog_changed: boolean;
};

function policyList(policy: Record<string, unknown>, key: string, owner = "release"): string[] {
  const value = policy[key];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new CliError(`::error::Invalid ${owner} policy field: ${key}.`, 65);
  }
  return value;
}

type AttributionPolicy = {
  blockedTerms: string[];
  identityOnlyTerms: string[];
  blockedTrailerKeys: string[];
  blockedLinePrefixes: string[];
};

async function loadAttributionPolicy(policyDir: string): Promise<AttributionPolicy> {
  const value = await readJson(join(policyDir, "attribution.json"));
  if (!isJsonRecord(value) || value.schema_version !== 1) {
    throw new CliError("::error::Invalid attribution policy.", 65);
  }
  return {
    blockedTerms: policyList(value, "blocked_terms", "attribution"),
    identityOnlyTerms: policyList(value, "identity_only_terms", "attribution"),
    blockedTrailerKeys: policyList(value, "blocked_trailer_keys", "attribution"),
    blockedLinePrefixes: policyList(value, "blocked_line_prefixes", "attribution"),
  };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Returns the first whole-word match of any term, ignoring case.
function termMatch(text: string, terms: readonly string[]): string | undefined {
  if (terms.length === 0) return undefined;
  const termPattern = new RegExp(`\\b(?:${terms.map(escapeRegExp).join("|")})\\b`, "i");
  return termPattern.exec(text)?.[0];
}

// Returns the first line that starts with an attribution prefix, ignoring case. Only line starts
// count, so prose that mentions the same words mid-sentence is not an attribution line.
function attributionLine(text: string, prefixes: readonly string[]): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    const lowered = trimmed.toLowerCase();
    if (prefixes.some((prefix) => lowered.startsWith(prefix.toLowerCase()))) {
      return trimmed;
    }
  }
  return undefined;
}

// A trailer such as "Co-Authored-By: Name <email>" is checked by its value, so a human co-author
// passes and an AI agent co-author fails. The key must be one of the policy trailer keys.
function trailerViolations(
  text: string,
  keys: readonly string[],
  terms: readonly string[]
): string[] {
  const found: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Za-z-]+):\s*(.*)$/.exec(line.trim());
    if (!match) continue;
    const key = (match[1] ?? "").toLowerCase();
    if (!keys.includes(key)) continue;
    const named = termMatch(match[2] ?? "", terms);
    if (named) {
      found.push(`trailer ${match[1]} names an AI agent or model: ${named}`);
    }
  }
  return found;
}

// Checks the PR title and every non-merge commit in base..head. The check blocks an AI agent or model
// as author or committer, a trailer whose value names one, and an attribution line such as
// "Generated with". Agent names in titles and in commit prose are allowed. Merge commits are skipped
// because git writes the branch name into their subject.
export async function assertAttributionFree(
  title: string,
  base: string,
  head: string,
  root: string,
  policyDir: string
): Promise<void> {
  const policy = await loadAttributionPolicy(policyDir);
  const problems: string[] = [];
  const titleLine = attributionLine(title, policy.blockedLinePrefixes);
  if (titleLine) {
    problems.push(`PR title is an attribution line: ${titleLine}`);
  }
  const log = await runText(
    "git",
    ["log", "--no-merges", "--format=%H%x1f%an%x1f%ae%x1f%cn%x1f%ce%x1f%B%x1e", `${base}..${head}`],
    { cwd: root }
  );
  const identityTerms = [...policy.blockedTerms, ...policy.identityOnlyTerms];
  for (const record of log.split("\x1e")) {
    const [
      sha = "",
      authorName = "",
      authorEmail = "",
      committerName = "",
      committerEmail = "",
      body = "",
    ] = record.split("\x1f");
    const commit = sha.trim();
    if (!commit) continue;
    const identity = [authorName, authorEmail, committerName, committerEmail].join("\n");
    const identityName = termMatch(identity, identityTerms);
    if (identityName) {
      problems.push(
        `commit ${commit.slice(0, 7)} author or committer names an AI agent or model: ${identityName}`
      );
    }
    for (const problem of trailerViolations(body, policy.blockedTrailerKeys, policy.blockedTerms)) {
      problems.push(`commit ${commit.slice(0, 7)} ${problem}`);
    }
    const bodyLine = attributionLine(body, policy.blockedLinePrefixes);
    if (bodyLine) {
      problems.push(`commit ${commit.slice(0, 7)} has an attribution line: ${bodyLine}`);
    }
  }
  if (problems.length > 0) {
    throw new CliError(
      `::error::Attribution check failed: ${problems.slice(0, 10).join("; ")}. Rewrite the listed commits so that the author and committer are your own GitHub account (git config user.name and user.email, then git rebase <base> --exec 'git commit --amend --no-edit --reset-author') and no trailer or line in the message names an AI agent (git rebase -i <base>, reword), then force-push the branch.`,
      65
    );
  }
}

// CHANGELOG_CONVENTIONS §4: which categories a PR type may write. A type missing from the
// policy writes no category of its own, so only the security category can satisfy it.
function changelogCategoriesForType(policy: Record<string, unknown>, changeType: string): string[] {
  const value = policy.changelog_category_types;
  if (!isJsonRecord(value)) {
    throw new CliError("::error::Invalid release policy field: changelog_category_types.", 65);
  }
  const categories = value[changeType];
  if (categories === undefined) return [];
  if (!Array.isArray(categories) || !categories.every((item) => typeof item === "string")) {
    throw new CliError(
      `::error::Invalid release policy field: changelog_category_types.${changeType}.`,
      65
    );
  }
  return categories;
}

// Non-release pull requests may add only new entries to [Unreleased].
function unreleasedBounds(content: string): { lines: string[]; start: number; end: number } {
  const lines = content.split(/\r?\n/);
  const start = lines.indexOf("## [Unreleased]");
  if (start < 0) throw new CliError("::error::CHANGELOG.md must contain ## [Unreleased].", 65);
  const next = lines.findIndex((line, index) => index > start && line.startsWith("## "));
  return { lines, start, end: next < 0 ? lines.length : next };
}

function unreleasedSection(content: string): string {
  const { lines, start, end } = unreleasedBounds(content);
  return lines.slice(start + 1, end).join("\n").trim();
}

function outsideUnreleased(content: string): string {
  const { lines, start, end } = unreleasedBounds(content);
  return [...lines.slice(0, start + 1), ...lines.slice(end)].join("\n").trimEnd();
}

export function addedUnreleasedEntries(baseContent: string, headContent: string): string[] {
  if (outsideUnreleased(baseContent) !== outsideUnreleased(headContent)) {
    throw new CliError("::error::A normal PR must not modify released CHANGELOG sections.", 65);
  }
  const previous = unreleasedSection(baseContent).split("\n").map((line) => line.trim()).filter(Boolean);
  const current = unreleasedSection(headContent).split("\n").map((line) => line.trim()).filter(Boolean);
  const additions: string[] = [];
  let nextPrevious = 0;
  for (const line of current) {
    if (line === previous[nextPrevious]) {
      nextPrevious += 1;
    } else if (previous.includes(line)) {
      throw new CliError("::error::A CHANGELOG entry was moved or duplicated.", 65);
    } else {
      additions.push(line);
    }
  }
  if (nextPrevious !== previous.length) {
    throw new CliError("::error::Existing [Unreleased] entries must not be removed or edited.", 65);
  }
  if (new Set(additions).size !== additions.length) {
    throw new CliError("::error::Duplicate new CHANGELOG entries are not allowed.", 65);
  }
  return additions;
}

// Release PRs may change only CHANGELOG.md. The expected content is rebuilt from the base.
async function assertReleasePullRequest(
  policy: Record<string, unknown>,
  root: string,
  base: string,
  changedPaths: readonly string[]
): Promise<void> {
  const changelogFile = policy.changelog_file as string;
  if (changedPaths.some((path) => path !== changelogFile)) {
    throw new CliError("::error::A release PR may modify only CHANGELOG.md.", 65);
  }
  const baseChangelog = await runText("git", ["show", `${base}:${changelogFile}`], { cwd: root });
  const headChangelog = await readFile(join(root, changelogFile), "utf8");
  const categories = policyList(policy, "changelog_categories");
  if (unreleasedSection(baseChangelog) === unreleasedSection(headChangelog)) {
    assertScopedReleaseChange({ baseChangelog, headChangelog, categories });
  } else {
    assertReleaseChange({ baseChangelog, headChangelog, categories });
  }
}

export async function validateChange(
  title: string,
  base: string,
  head: string,
  root: string,
  policyDir: string
): Promise<ChangeRecord> {
  const value = await readJson(join(policyDir, "release.json"));
  if (!isJsonRecord(value) || typeof value.changelog_file !== "string") {
    throw new CliError("::error::Invalid release policy.", 65);
  }
  await assertAttributionFree(title, base, head, root, policyDir);
  const match = /^([a-z]+)(?:\(([A-Za-z0-9._/-]+)\))?(!)?:\s+(.+)$/.exec(title);
  if (!match) {
    throw new CliError(
      `::error::PR title must use type(scope)!: summary format, for example 'fix(deploy): retry the health check'. Allowed types: ${policyList(value, "change_types").join(", ")}. Edit the pull request title.`,
      64
    );
  }
  const changeType = match[1] ?? "";
  const scope = match[2] ?? "";
  const isBreaking = match[3] === "!";
  const summary = match[4] ?? "";
  assertEnglishText("PR title summary", summary);
  const changeTypes = policyList(value, "change_types");
  const allowedAttrs = policyList(value, "change_attributes");
  const requiredTypes = policyList(value, "changelog_required_types");
  if (!changeTypes.includes(changeType)) {
    throw new CliError(`::error::Unsupported change type: ${changeType}.`, 64);
  }
  const changelogFile = value.changelog_file;
  const changedText = await runText(
    "git",
    ["diff", "--name-only", "--diff-filter=ACMR", base, head],
    { cwd: root }
  );
  const changedPaths = changedText.split(/\r?\n/).filter(Boolean);
  // Release PRs promote [Unreleased] into one verified version section.
  if (changeType === "chore" && scope === "release") {
    await assertReleasePullRequest(value, root, base, changedPaths);
    return {
      schema_version: "1",
      type: changeType,
      scope,
      attributes: [],
      summary,
      changelog_required: false,
      changelog_changed: true,
    };
  }
  const legacyPaths = changedPaths.filter((path) => path.startsWith("changelog.d/"));
  if (legacyPaths.length > 0) {
    throw new CliError("::error::changelog.d is retired. Write Chinese entries in CHANGELOG.md.", 65);
  }
  const changelogRequired = isBreaking || requiredTypes.includes(changeType);
  if (changelogRequired && !changedPaths.includes(changelogFile)) {
    throw new CliError(`::error::Change type ${changeType} must update CHANGELOG.md [Unreleased].`, 65);
  }
  let entries: string[] = [];
  if (changedPaths.includes(changelogFile)) {
    const baseChangelog = await runText("git", ["show", `${base}:${changelogFile}`], { cwd: root });
    const headChangelog = await readFile(join(root, changelogFile), "utf8");
    entries = addedUnreleasedEntries(baseChangelog, headChangelog);
  }
  const categories = policyList(value, "changelog_categories");
  const allowedCategories = changelogCategoriesForType(value, changeType);
  const securityCategory = value.security_category;
  if (typeof securityCategory !== "string" || !categories.includes(securityCategory)) {
    throw new CliError("::error::Invalid release policy field: security_category.", 65);
  }
  let hasMatching = false;
  for (const line of entries) {
    const entry = parseEntry(line);
    if (!entry) {
      throw new CliError(`::error::Invalid CHANGELOG entry: ${line}. Expected '- 修复: 中文摘要'.`, 65);
    }
    assertChineseSummary(entry.summary);
    if (!categories.includes(entry.category)) {
      throw new CliError(`::error::Unknown CHANGELOG category: ${entry.category}.`, 65);
    }
    if (entry.attributes.some((attribute) => !allowedAttrs.includes(attribute))) {
      throw new CliError(`::error::Unsupported CHANGELOG attributes: ${entry.attributes.join(", ")}.`, 65);
    }
    const security = entry.attributes.includes("security");
    if (security !== (entry.category === securityCategory)) {
      throw new CliError("::error::Security entries must use 安全 [security], and vice versa.", 65);
    }
    if (allowedCategories.includes(entry.category) || entry.category === securityCategory) {
      hasMatching = true;
      if (isBreaking && !entry.attributes.includes("breaking")) {
        throw new CliError("::error::A breaking CHANGELOG entry must carry breaking.", 65);
      }
    }
  }
  if (changelogRequired && !hasMatching) {
    throw new CliError(`::error::CHANGELOG.md must add an entry matching PR type '${changeType}'.`, 65);
  }
  return {
    schema_version: "1",
    type: changeType,
    scope: scope || null,
    attributes: isBreaking ? ["breaking"] : [],
    summary,
    changelog_required: changelogRequired,
    changelog_changed: entries.length > 0,
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 5) {
    throw new CliError(
      "Usage: validate-change-record.ts <pr-title> <base-sha> <head-sha> <repo-root> <policy-dir>",
      64
    );
  }
  const [title = "", base = "", head = "", root = "", policyDir = ""] = args;
  const record = await validateChange(title, base, head, root, policyDir);
  const output = JSON.stringify(record);
  if (process.env.GITHUB_OUTPUT) {
    await writeFile("/tmp/change-record.json", `${output}\n`, "utf8");
    await appendLines(process.env.GITHUB_OUTPUT, [`json=${output}`]);
  }
  console.log(output);
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
