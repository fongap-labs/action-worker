import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CliError,
  handleError,
  isMain,
  readJson,
  runText,
} from "./runtime-command.ts";
import { isJsonRecord } from "./github-api.ts";

type NamedPattern = {
  name: string;
  pattern: string;
};

type SecurityPolicy = {
  schema_version: number;
  path_allow_patterns: string[];
  forbidden_path_patterns: string[];
  secret_patterns: NamedPattern[];
  workflow_forbidden_patterns: NamedPattern[];
  require_pinned_actions: boolean;
};

export type SecurityViolation = {
  rule: string;
  path: string;
  line?: number;
};

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new CliError(`::error::Invalid security policy field: ${label}.`, 65);
  }
  return value;
}

function namedPatterns(value: unknown, label: string): NamedPattern[] {
  if (!Array.isArray(value)) {
    throw new CliError(`::error::Invalid security policy field: ${label}.`, 65);
  }
  return value.map((item) => {
    if (!isJsonRecord(item) || typeof item.name !== "string" || typeof item.pattern !== "string") {
      throw new CliError(`::error::Invalid security policy entry: ${label}.`, 65);
    }
    return { name: item.name, pattern: item.pattern };
  });
}

function parsePolicy(value: unknown): SecurityPolicy {
  if (!isJsonRecord(value) || value.schema_version !== 2 || typeof value.require_pinned_actions !== "boolean") {
    throw new CliError("::error::Invalid security policy.", 65);
  }
  return {
    schema_version: 2,
    path_allow_patterns: stringArray(value.path_allow_patterns, "path_allow_patterns"),
    forbidden_path_patterns: stringArray(value.forbidden_path_patterns, "forbidden_path_patterns"),
    secret_patterns: namedPatterns(value.secret_patterns, "secret_patterns"),
    workflow_forbidden_patterns: namedPatterns(value.workflow_forbidden_patterns, "workflow_forbidden_patterns"),
    require_pinned_actions: value.require_pinned_actions,
  };
}

function compile(pattern: string, flags = ""): RegExp {
  try {
    return new RegExp(pattern, flags);
  } catch {
    throw new CliError("::error::Invalid regular expression in security policy.", 65);
  }
}

function isWorkflowPath(path: string): boolean {
  return /^\.github\/(?:workflows\/.*\.ya?ml|actions\/.*\/action\.ya?ml)$/.test(path);
}

function scanPinnedActions(path: string, content: string): SecurityViolation[] {
  const violations: SecurityViolation[] = [];
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index]?.match(/^\s*uses:\s*([^\s#]+)(?:\s+#.*)?$/);
    const value = match?.[1] ?? "";
    if (!value || value.startsWith("./") || value.startsWith("docker://")) {
      continue;
    }
    const at = value.lastIndexOf("@");
    const ref = at >= 0 ? value.slice(at + 1) : "";
    if (!/^[0-9a-f]{40}$/i.test(ref)) {
      violations.push({ rule: "unpinned-action", path, line: index + 1 });
    }
  }
  return violations;
}

function scanAddedLines(diff: string, patterns: Array<{ name: string; regex: RegExp }>): SecurityViolation[] {
  const violations: SecurityViolation[] = [];
  let path = "";
  let lineNumber = 0;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("+++ b/")) {
      path = line.slice(6);
      continue;
    }
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      lineNumber = Number(hunk[1]);
      continue;
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      const added = line.slice(1);
      for (const { name, regex } of patterns) {
        regex.lastIndex = 0;
        if (regex.test(added)) {
          violations.push({ rule: name, path: path || "unknown", line: lineNumber });
        }
      }
      lineNumber += 1;
      continue;
    }
    if (!line.startsWith("-")) {
      lineNumber += 1;
    }
  }
  return violations;
}

export async function collectSecurityViolations(
  root: string,
  base: string,
  head: string,
  policyPath: string,
): Promise<SecurityViolation[]> {
  if (!/^[0-9a-f]{40}$/i.test(base) || !/^[0-9a-f]{40}$/i.test(head)) {
    throw new CliError("::error::Security scan requires full base and head commit SHAs.", 64);
  }

  const policy = parsePolicy(await readJson(policyPath));
  const allowPaths = policy.path_allow_patterns.map((pattern) => compile(pattern));
  const forbiddenPaths = policy.forbidden_path_patterns.map((pattern) => compile(pattern));
  const secretPatterns = policy.secret_patterns.map(({ name, pattern }) => ({ name, regex: compile(pattern) }));
  const workflowPatterns = policy.workflow_forbidden_patterns.map(({ name, pattern }) => ({ name, regex: compile(pattern, "m") }));

  const names = await runText("git", ["diff", "--name-only", "--diff-filter=ACMR", base, head, "--"], { cwd: root });
  const changed = names.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  const violations: SecurityViolation[] = [];

  for (const path of changed) {
    const isAllowedPath = allowPaths.some((regex) => regex.test(path));
    if (!isAllowedPath && forbiddenPaths.some((regex) => regex.test(path))) {
      violations.push({ rule: "sensitive-path", path });
    }

    if (isWorkflowPath(path)) {
      const content = await readFile(join(root, path), "utf8");
      for (const { name, regex } of workflowPatterns) {
        regex.lastIndex = 0;
        if (regex.test(content)) {
          violations.push({ rule: name, path });
        }
      }
      if (policy.require_pinned_actions) {
        violations.push(...scanPinnedActions(path, content));
      }
    }
  }

  const diff = await runText(
    "git",
    ["diff", "--unified=0", "--no-color", "--no-ext-diff", base, head, "--"],
    { cwd: root, maxBuffer: 16 * 1024 * 1024 },
  );
  violations.push(...scanAddedLines(diff, secretPatterns));

  const unique = new Map<string, SecurityViolation>();
  for (const violation of violations) {
    unique.set(`${violation.rule}\0${violation.path}\0${violation.line ?? 0}`, violation);
  }
  return [...unique.values()].sort((left, right) =>
    left.path.localeCompare(right.path, "en")
    || (left.line ?? 0) - (right.line ?? 0)
    || left.rule.localeCompare(right.rule, "en"));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 4) {
    throw new CliError("Usage: validate-security.ts <base-sha> <head-sha> <repository-path> <policy-path>", 64);
  }
  const [base = "", head = "", root = "", policyPath = ""] = args;
  const violations = await collectSecurityViolations(root, base, head, policyPath);
  if (violations.length > 0) {
    for (const violation of violations) {
      const location = violation.line ? `${violation.path}:${violation.line}` : violation.path;
      console.error(`::error file=${violation.path}${violation.line ? `,line=${violation.line}` : ""}::Security gate violation [${violation.rule}] at ${location}. Sensitive content is intentionally not echoed.`);
    }
    throw new CliError(`::error::Security gate failed with ${violations.length} violation(s).`, 1);
  }
  console.log("Security gate passed.");
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
