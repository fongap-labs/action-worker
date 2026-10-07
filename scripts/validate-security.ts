import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isJsonRecord } from "./github-api.ts";
import { CliError, handleError, isMain, readJson, runText } from "./runtime-command.ts";

type NamedPattern = {
  name: string;
  pattern: string;
};

// A known harmless match of a secret pattern, accepted only when BOTH hold: the file path matches
// "path" and the whole matched text matches "pattern" (full match, not a substring). A line is
// reported unless every match on it is accepted this way, so an allowance for one fixture value
// never lets a real credential on the same line or in the same file through.
type SecretAllowance = {
  path: string;
  pattern: string;
  reason: string;
};

type SecurityPolicy = {
  schema_version: number;
  path_allow_patterns: string[];
  forbidden_path_patterns: string[];
  secret_patterns: NamedPattern[];
  secret_allowlist: SecretAllowance[];
  workflow_forbidden_patterns: NamedPattern[];
  approved_workflows: ApprovedWorkflow[];
  require_pinned_actions: boolean;
};

// A workflow file is exempt from workflow_forbidden_patterns only while its content, with line
// endings normalized to LF, hashes to the audited value. Any edit puts it back under the rules.
type ApprovedWorkflow = {
  path: string;
  sha256: string;
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

function secretAllowlist(value: unknown): SecretAllowance[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new CliError("::error::Invalid security policy field: secret_allowlist.", 65);
  }
  return value.map((item) => {
    if (
      !isJsonRecord(item) ||
      typeof item.path !== "string" ||
      typeof item.pattern !== "string" ||
      typeof item.reason !== "string" ||
      item.reason.trim() === ""
    ) {
      throw new CliError("::error::Invalid security policy entry: secret_allowlist.", 65);
    }
    return { path: item.path, pattern: item.pattern, reason: item.reason };
  });
}

function approvedWorkflows(value: unknown): ApprovedWorkflow[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new CliError("::error::Invalid security policy field: approved_workflows.", 65);
  }
  return value.map((item) => {
    if (
      !isJsonRecord(item) ||
      typeof item.path !== "string" ||
      !/^\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml$/.test(item.path) ||
      typeof item.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(item.sha256)
    ) {
      throw new CliError("::error::Invalid security policy entry: approved_workflows.", 65);
    }
    return { path: item.path, sha256: item.sha256 };
  });
}

export function workflowContentHash(content: string): string {
  return createHash("sha256").update(content.replace(/\r\n/g, "\n"), "utf8").digest("hex");
}

function parsePolicy(value: unknown): SecurityPolicy {
  if (
    !isJsonRecord(value) ||
    value.schema_version !== 2 ||
    typeof value.require_pinned_actions !== "boolean"
  ) {
    throw new CliError("::error::Invalid security policy.", 65);
  }
  return {
    schema_version: 2,
    path_allow_patterns: stringArray(value.path_allow_patterns, "path_allow_patterns"),
    forbidden_path_patterns: stringArray(value.forbidden_path_patterns, "forbidden_path_patterns"),
    secret_patterns: namedPatterns(value.secret_patterns, "secret_patterns"),
    secret_allowlist: secretAllowlist(value.secret_allowlist),
    workflow_forbidden_patterns: namedPatterns(
      value.workflow_forbidden_patterns,
      "workflow_forbidden_patterns"
    ),
    approved_workflows: approvedWorkflows(value.approved_workflows),
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
    const match = lines[index]?.match(/^\s*(?:-\s*)?uses:\s*([^\s#]+)(?:\s+#.*)?$/);
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

type CompiledAllowance = { path: RegExp; pattern: RegExp };

function isAllowedMatch(path: string, text: string, allowances: CompiledAllowance[]): boolean {
  return allowances.some((allowance) => {
    if (!allowance.path.test(path)) {
      return false;
    }
    const found = allowance.pattern.exec(text);
    return found !== null && found.index === 0 && found[0].length === text.length;
  });
}

function scanAddedLines(
  diff: string,
  patterns: Array<{ name: string; regex: RegExp }>,
  allowances: CompiledAllowance[] = []
): SecurityViolation[] {
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
        const every = new RegExp(
          regex.source,
          regex.flags.includes("g") ? regex.flags : regex.flags + "g"
        );
        const matches = [...added.matchAll(every)];
        if (matches.some((match) => !isAllowedMatch(path, match[0], allowances))) {
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
  policyPath: string
): Promise<SecurityViolation[]> {
  if (!/^[0-9a-f]{40}$/i.test(base) || !/^[0-9a-f]{40}$/i.test(head)) {
    throw new CliError("::error::Security scan requires full base and head commit SHAs.", 64);
  }

  const policy = parsePolicy(await readJson(policyPath));
  const allowPaths = policy.path_allow_patterns.map((pattern) => compile(pattern));
  const forbiddenPaths = policy.forbidden_path_patterns.map((pattern) => compile(pattern));
  const secretPatterns = policy.secret_patterns.map(({ name, pattern }) => ({
    name,
    regex: compile(pattern),
  }));
  const allowances = policy.secret_allowlist.map(({ path, pattern }) => ({
    path: compile(path),
    pattern: compile(pattern),
  }));
  const workflowPatterns = policy.workflow_forbidden_patterns.map(({ name, pattern }) => ({
    name,
    regex: compile(pattern, "m"),
  }));

  const names = await runText(
    "git",
    ["diff", "--name-only", "--diff-filter=ACMR", base, head, "--"],
    { cwd: root }
  );
  const changed = names
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
  const violations: SecurityViolation[] = [];

  for (const path of changed) {
    const isAllowedPath = allowPaths.some((regex) => regex.test(path));
    if (!isAllowedPath && forbiddenPaths.some((regex) => regex.test(path))) {
      violations.push({ rule: "sensitive-path", path });
    }

    if (isWorkflowPath(path)) {
      const content = await readFile(join(root, path), "utf8");
      const contentHash = workflowContentHash(content);
      const isApproved = policy.approved_workflows.some(
        (approved) => approved.path === path && approved.sha256 === contentHash
      );
      for (const { name, regex } of isApproved ? [] : workflowPatterns) {
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
    { cwd: root, maxBuffer: 64 * 1024 * 1024 }
  );
  violations.push(...scanAddedLines(diff, secretPatterns, allowances));

  const unique = new Map<string, SecurityViolation>();
  for (const violation of violations) {
    unique.set(`${violation.rule}\0${violation.path}\0${violation.line ?? 0}`, violation);
  }
  return [...unique.values()].sort(
    (left, right) =>
      left.path.localeCompare(right.path, "en") ||
      (left.line ?? 0) - (right.line ?? 0) ||
      left.rule.localeCompare(right.rule, "en")
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 4) {
    throw new CliError(
      "Usage: validate-security.ts <base-sha> <head-sha> <repository-path> <policy-path>",
      64
    );
  }
  const [base = "", head = "", root = "", policyPath = ""] = args;
  const violations = await collectSecurityViolations(root, base, head, policyPath);
  if (violations.length > 0) {
    for (const violation of violations) {
      const location = violation.line ? `${violation.path}:${violation.line}` : violation.path;
      console.error(
        `::error file=${violation.path}${violation.line ? `,line=${violation.line}` : ""}::Security gate violation [${violation.rule}] at ${location}. Sensitive content is intentionally not echoed.`
      );
    }
    throw new CliError(`::error::Security gate failed with ${violations.length} violation(s).`, 1);
  }
  console.log("Security gate passed.");
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
