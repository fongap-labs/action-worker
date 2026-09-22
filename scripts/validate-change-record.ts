import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isJsonRecord } from "./github-api.ts";
import { assertEnglishText } from "./validate-engineering-language.ts";
import {
  CliError,
  appendLines,
  handleError,
  isMain,
  readJson,
  runText,
} from "./runtime-command.ts";

type ChangeRecord = {
  schema_version: "1";
  type: string;
  scope: string | null;
  attributes: string[];
  summary: string;
  changelog_required: boolean;
  changelog_changed: boolean;
};

function policyList(policy: Record<string, unknown>, key: string): string[] {
  const value = policy[key];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new CliError(`::error::Invalid release policy field: ${key}.`, 65);
  }
  return value;
}

export async function validateChange(
  title: string,
  base: string,
  head: string,
  root: string,
  policyDir: string,
): Promise<ChangeRecord> {
  const value = await readJson(join(policyDir, "release.json"));
  if (!isJsonRecord(value) || typeof value.changelog_file !== "string") {
    throw new CliError("::error::Invalid release policy.", 65);
  }
  const match = /^([a-z]+)(?:\(([A-Za-z0-9._/-]+)\))?(!)?:\s+(.+)$/.exec(title);
  if (!match) {
    throw new CliError("::error::PR title must use type(scope)!: summary format.", 64);
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
  const changedText = await runText("git", ["diff", "--name-only", "--diff-filter=ACMR", base, head], { cwd: root });
  const changelogChanged = changedText.split(/\r?\n/).includes(changelogFile);
  const changelogRequired = isBreaking || requiredTypes.includes(changeType);
  if (changelogRequired && !changelogChanged) {
    throw new CliError(`::error::Change type ${changeType} must update ${changelogFile}.`, 65);
  }
  if (changelogChanged) {
    const content = await readFile(join(root, changelogFile), "utf8");
    if (!content.split(/\r?\n/).includes("## [Unreleased]")) {
      throw new CliError(`::error::${changelogFile} must contain ## [Unreleased].`, 65);
    }
    const diff = await runText("git", ["diff", "--unified=0", base, head, "--", changelogFile], { cwd: root });
    const additions = diff.split(/\r?\n/)
      .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
      .map((line) => line.slice(1));
    let hasMatching = false;
    for (const line of additions.filter((entry) => entry.startsWith("- "))) {
      const entry = /^- ([a-z]+)(?: \[([^\]]+)\])?: (.+)$/.exec(line);
      if (!entry) {
        throw new CliError(`::error::Invalid CHANGELOG entry: ${line}`, 65);
      }
      const entryType = entry[1] ?? "";
      const entrySummary = entry[3] ?? "";
      assertEnglishText("CHANGELOG entry summary", entrySummary);
      if (!changeTypes.includes(entryType)) {
        throw new CliError(`::error::CHANGELOG uses unsupported change type: ${entryType}.`, 65);
      }
      const attributes = (entry[2] ?? "").split(",").map((item) => item.trim()).filter(Boolean);
      if (attributes.some((item) => !allowedAttrs.includes(item))) {
        throw new CliError(`::error::CHANGELOG contains unsupported attributes: ${entry[2] ?? ""}.`, 65);
      }
      // Match on changeType AND (scope or summary) to ensure the entry corresponds to this PR
      const entryScope = entry[2]?.split(",").map((item) => item.trim()).filter(Boolean) ?? [];
      const scopeMatch = scope ? entryScope.includes(scope) : true;
      const summaryMatch = entrySummary.toLowerCase().includes(summary.toLowerCase()) || summary.toLowerCase().includes(entrySummary.toLowerCase());
      if (entryType === changeType && (scopeMatch || summaryMatch)) {
        hasMatching = true;
        if (isBreaking && !attributes.includes("breaking")) {
          throw new CliError("::error::A breaking PR CHANGELOG entry must include the breaking attribute.", 65);
        }
      }
    }
    if (changelogRequired && !hasMatching) {
      throw new CliError(`::error::CHANGELOG must add an entry matching PR type '${changeType}'.`, 65);
    }
  }
  return {
    schema_version: "1",
    type: changeType,
    scope: scope || null,
    attributes: isBreaking ? ["breaking"] : [],
    summary,
    changelog_required: changelogRequired,
    changelog_changed: changelogChanged,
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 5) {
    throw new CliError("Usage: validate-change-record.ts <pr-title> <base-sha> <head-sha> <repo-root> <policy-dir>", 64);
  }
  const [title = "", base = "", head = "", root = "", policyDir = ""] = args;
  const record = await validateChange(title, base, head, root, policyDir);
  const output = JSON.stringify(record);
  if (process.env.GITHUB_OUTPUT) {
    await writeFile(join(tmpdir(), "change-record.json"), `${output}\n`, "utf8");
    await appendLines(process.env.GITHUB_OUTPUT, [`json=${output}`]);
  }
  console.log(output);
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
