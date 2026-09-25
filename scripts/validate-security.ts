import {
  CliError,
  appendLines,
  handleError,
  isMain,
  readJson,
  runText,
} from "./runtime-command.ts";

type PatternRule = {
  id: string;
  pattern: string;
};

type SecurityPolicy = {
  schema_version: 2;
  sensitive_paths: {
    deny: string[];
    allow: string[];
  };
  secret_patterns: PatternRule[];
  workflow_guards: {
    forbid_pull_request_target: boolean;
    forbid_write_all: boolean;
    forbid_to_json_secrets: boolean;
    forbid_direct_secret_in_run: boolean;
  };
};

type Violation = {
  rule: string;
  path: string;
  line?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new CliError(`::error::Invalid security policy: ${label} must be a string array.`, 65);
  }
  return value as string[];
}

export function parseSecurityPolicy(value: unknown): SecurityPolicy {
  if (!isRecord(value) || value.schema_version !== 2) {
    throw new CliError("::error::Invalid security policy schema.", 65);
  }
  const paths = value.sensitive_paths;
  const guards = value.workflow_guards;
  if (!isRecord(paths) || !isRecord(guards) || !Array.isArray(value.secret_patterns)) {
    throw new CliError("::error::Invalid security policy structure.", 65);
  }
  const secretPatterns = value.secret_patterns.map((item) => {
    if (!isRecord(item) || typeof item.id !== "string" || typeof item.pattern !== "string" || !item.id || !item.pattern) {
      throw new CliError("::error::Invalid security secret pattern.", 65);
    }
    try {
      new RegExp(item.pattern);
    } catch {
      throw new CliError(`::error::Invalid security regex for rule ${item.id}.`, 65);
    }
    return { id: item.id, pattern: item.pattern };
  });
  for (const key of [
    "forbid_pull_request_target",
    "forbid_write_all",
    "forbid_to_json_secrets",
    "forbid_direct_secret_in_run",
  ]) {
    if (typeof guards[key] !== "boolean") {
      throw new CliError(`::error::Invalid security workflow guard: ${key}.`, 65);
    }
  }
  return {
    schema_version: 2,
    sensitive_paths: {
      deny: stringArray(paths.deny, "sensitive_paths.deny"),
      allow: stringArray(paths.allow, "sensitive_paths.allow"),
    },
    secret_patterns: secretPatterns,
    workflow_guards: {
      forbid_pull_request_target: guards.forbid_pull_request_target as boolean,
      forbid_write_all: guards.forbid_write_all as boolean,
      forbid_to_json_secrets: guards.forbid_to_json_secrets as boolean,
      forbid_direct_secret_in_run: guards.forbid_direct_secret_in_run as boolean,
    },
  };
}

function matchesAny(path: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => new RegExp(pattern, "i").test(path));
}

function addedLines(diff: string): Array<{ line: number; text: string }> {
  const lines = diff.split(/\r?\n/);
  const added: Array<{ line: number; text: string }> = [];
  let newLine = 0;
  for (const raw of lines) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      newLine = Number(hunk[1]);
      continue;
    }
    if (raw.startsWith("+++")) {
      continue;
    }
    if (raw.startsWith("+")) {
      added.push({ line: newLine, text: raw.slice(1) });
      newLine += 1;
      continue;
    }
    if (raw.startsWith("-") || raw.startsWith("diff ") || raw.startsWith("index ") || raw.startsWith("---")) {
      continue;
    }
    if (newLine > 0) {
      newLine += 1;
    }
  }
  return added;
}

export function validateWorkflowText(path: string, content: string, policy: SecurityPolicy): Violation[] {
  const violations: Violation[] = [];
  const lines = content.split(/\r?\n/);
  const add = (rule: string, line: number): void => {
    violations.push({ rule, path, line });
  };

  let runIndent: number | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const text = lines[index] ?? "";
    const line = index + 1;
    const indent = /^\s*/.exec(text)?.[0].length ?? 0;
    const trimmed = text.trim();

    if (policy.workflow_guards.forbid_pull_request_target && /^pull_request_target\s*:/.test(trimmed)) {
      add("workflow-pull-request-target", line);
    }
    if (policy.workflow_guards.forbid_write_all && /\bwrite-all\b/i.test(trimmed)) {
      add("workflow-write-all", line);
    }
    if (policy.workflow_guards.forbid_to_json_secrets && /tojson\s*\(\s*secrets\s*\)/i.test(trimmed)) {
      add("workflow-secrets-serialization", line);
    }

    const runMatch = /^(\s*)run\s*:\s*(.*)$/.exec(text);
    if (runMatch) {
      runIndent = runMatch[1]?.length ?? 0;
      if (
        policy.workflow_guards.forbid_direct_secret_in_run
        && /\$\{\{\s*secrets\./.test(runMatch[2] ?? "")
      ) {
        add("workflow-direct-secret-in-run", line);
      }
      continue;
    }

    if (runIndent !== undefined) {
      if (trimmed && indent <= runIndent) {
        runIndent = undefined;
      } else if (
        policy.workflow_guards.forbid_direct_secret_in_run
        && /\$\{\{\s*secrets\./.test(text)
      ) {
        add("workflow-direct-secret-in-run", line);
      }
    }
  }
  return violations;
}

export async function validateSecurityRange(
  base: string,
  head: string,
  root: string,
  policyValue: unknown,
): Promise<Violation[]> {
  if (!/^[0-9a-f]{40}$/.test(base) || !/^[0-9a-f]{40}$/.test(head)) {
    throw new CliError("::error::Security scan requires full base and head commit SHAs.", 65);
  }
  const policy = parseSecurityPolicy(policyValue);
  const changed = (await runText(
    "git",
    ["diff", "--name-only", "--diff-filter=ACMR", base, head, "--"],
    { cwd: root },
  )).split(/\r?\n/).filter(Boolean);

  const violations: Violation[] = [];
  const secretPatterns = policy.secret_patterns.map((rule) => ({
    id: rule.id,
    regex: new RegExp(rule.pattern),
  }));

  for (const path of changed) {
    if (
      matchesAny(path, policy.sensitive_paths.deny)
      && !matchesAny(path, policy.sensitive_paths.allow)
    ) {
      violations.push({ rule: "sensitive-path", path });
    }

    const diff = await runText(
      "git",
      ["diff", "--unified=0", "--no-color", base, head, "--", path],
      { cwd: root },
    );
    for (const added of addedLines(diff)) {
      for (const rule of secretPatterns) {
        if (rule.regex.test(added.text)) {
          violations.push({ rule: rule.id, path, line: added.line });
        }
      }
    }

    if (/^\.github\/workflows\/.*\.ya?ml$/i.test(path)) {
      const content = await runText("git", ["show", `${head}:${path}`], { cwd: root });
      violations.push(...validateWorkflowText(path, content, policy));
    }
  }
  return violations;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 4) {
    throw new CliError("Usage: validate-security.ts <base-sha> <head-sha> <repository-root> <policy-file>", 64);
  }
  const [base = "", head = "", root = "", policyPath = ""] = args;
  const policy = await readJson(policyPath);
  const violations = await validateSecurityRange(base, head, root, policy);

  await appendLines(process.env.GITHUB_STEP_SUMMARY, [
    "### Security Gate",
    "",
    `- violations: ${violations.length}`,
    "- scope: added secret material, sensitive paths, and workflow leak guards",
  ]);

  if (violations.length > 0) {
    const details = violations.slice(0, 20).map((item) => {
      const location = item.line === undefined ? item.path : `${item.path}:${item.line}`;
      return `- ${location} [${item.rule}]`;
    });
    throw new CliError(
      ["::error::Security gate rejected the change. Secret values are intentionally not printed.", ...details].join("\n"),
      1,
    );
  }
  console.log("Security gate passed.");
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
