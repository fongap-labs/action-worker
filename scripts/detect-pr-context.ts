import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isJsonRecord } from "./github-api.ts";
import {
  CliError,
  appendLines,
  handleError,
  isMain,
  readJson,
  runText,
} from "./runtime-command.ts";

type ContextResult = {
  changed_files: string[];
  project_types: string[];
  change_areas: string[];
  changelog_changed: boolean;
  declared_impacts: string[];
  risk: "low" | "medium" | "high";
};

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function stringList(value: unknown, key: string): string[] {
  if (!isJsonRecord(value) || !Array.isArray(value[key]) || !value[key].every((item) => typeof item === "string")) {
    throw new CliError(`ERROR: invalid context policy field: ${key}.`, 65);
  }
  return value[key];
}

export async function listChangedFiles(base: string, head: string, root: string): Promise<string[]> {
  const changedText = await runText(
    "git",
    ["diff", "--name-only", "--diff-filter=ACDMR", base, head],
    { cwd: root },
  );
  return changedText ? changedText.split(/\r?\n/).filter(Boolean) : [];
}

export function changeAreaForPath(path: string, workflowPrefixes: readonly string[], changelogFile: string): string {
  if (workflowPrefixes.some((prefix) => path.startsWith(prefix))) {
    return "workflow";
  }
  if (path.startsWith("scripts/") || path.endsWith(".sh")) {
    return "script";
  }
  if (/^(?:tests?|.*(?:_test|\.test)\.)/.test(path)) {
    return "test";
  }
  if (/(^|\/)(?:Dockerfile|docker-compose\.ya?ml|compose\.ya?ml)$/.test(path)) {
    return "container";
  }
  if (path === changelogFile || path.endsWith(".md") || path.startsWith("docs/")) {
    return "documentation";
  }
  return "source";
}

export async function detectContext(base: string, head: string, root: string, policyDir: string): Promise<ContextResult> {
  const workflow = await readJson(join(policyDir, "workflow.json"));
  const security = await readJson(join(policyDir, "security.json"));
  const release = await readJson(join(policyDir, "release.json"));
  if (!isJsonRecord(release) || typeof release.changelog_file !== "string" || !isJsonRecord(release.impact_patterns)) {
    throw new CliError("ERROR: invalid release context policy.", 65);
  }
  const prefixes = stringList(workflow, "path_prefixes");
  const terms = stringList(security, "path_terms").map((term) => term.toLowerCase());
  const changedFiles = await listChangedFiles(base, head, root);
  const areas = new Set<string>();
  const impacts = new Set<string>();

  for (const path of changedFiles) {
    areas.add(changeAreaForPath(path, prefixes, release.changelog_file));
    const lowerPath = path.toLowerCase();
    if (terms.some((term) => lowerPath.includes(term))) {
      areas.add("security");
    }
  }

  const projectChecks: Array<[string, string]> = [
    ["package.json", "node"],
    ["Cargo.toml", "rust"],
    ["pyproject.toml", "python"],
    ["requirements.txt", "python"],
    ["go.mod", "go"],
    ["Dockerfile", "container"],
    [".github/workflows", "github-automation"],
  ];
  const projects = new Set<string>();
  for (const [path, project] of projectChecks) {
    if (await pathExists(join(root, path))) {
      projects.add(project);
    }
  }

  const hasChangelog = changedFiles.includes(release.changelog_file);
  let additions = "";
  if (hasChangelog) {
    const diff = await runText("git", ["diff", "--unified=0", base, head, "--", release.changelog_file], { cwd: root });
    additions = diff.split(/\r?\n/)
      .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
      .map((line) => line.slice(1))
      .join("\n")
      .toLowerCase();
  }
  for (const category of ["breaking", "security", "migration", "api", "deployment", "performance", "compatibility", "release"]) {
    const patterns = release.impact_patterns[category];
    if (Array.isArray(patterns) && patterns.some((pattern) => typeof pattern === "string" && additions.includes(pattern.toLowerCase()))) {
      impacts.add(category);
    }
  }

  const highSignals = ["security"].some((value) => areas.has(value))
    || ["security", "breaking", "migration", "deployment"].some((value) => impacts.has(value));
  const mediumSignals = ["source", "workflow", "script", "container", "release"].some((value) => areas.has(value))
    || ["api", "performance", "compatibility", "release"].some((value) => impacts.has(value));
  return {
    changed_files: changedFiles,
    project_types: [...projects].sort(),
    change_areas: [...areas].sort(),
    changelog_changed: hasChangelog,
    declared_impacts: [...impacts].sort(),
    risk: highSignals ? "high" : mediumSignals ? "medium" : "low",
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 4) {
    throw new CliError("Usage: detect-pr-context.ts <base-sha> <head-sha> <repo-root> <policy-dir>", 64);
  }
  const [base = "", head = "", root = "", policyDir = ""] = args;
  try {
    const detected = await detectContext(base, head, root, policyDir);
    const changeText = process.env.CHANGE_RECORD_JSON;
    const output = changeText
      ? { ...detected, change_record: JSON.parse(changeText) as unknown }
      : detected;
    const json = JSON.stringify(output);
    if (process.env.GITHUB_OUTPUT) {
      await writeFile("/tmp/pr-context.json", `${json}\n`, "utf8");
      await appendLines(process.env.GITHUB_OUTPUT, [`json=${json}`]);
    }
    console.log(json);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new CliError(`::error::Missing context input: ${error.message}`, 65);
    }
    throw error;
  }
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
