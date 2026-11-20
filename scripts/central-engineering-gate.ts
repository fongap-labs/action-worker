import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CliError, handleError, isMain } from "./runtime-command.ts";

export type ChangedFile = { status: "A" | "M" | "T"; path: string };
type LocalException = { repository: string; path_prefix: string; reason: string };
export type OwnershipPolicy = {
  schema_version: 1;
  control_repository: string;
  workflow_templates: Record<string, string>;
  local_test_exceptions: LocalException[];
};
export type OwnershipFinding = { code: string; path: string };

const repositoryName = /^fongap-labs\/[A-Za-z0-9_.-]+$/;
const workflowName = /^\.github\/workflows\/[A-Za-z0-9_.-]+\.(?:yml|yaml)$/;
const safePath = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\\)[^\r\n\0]+$/;
const shaPattern = /^[0-9a-f]{40}$/;
const testFile = /(?:^|\/)(?:tests?|__tests__)\/|(?:^|\/)test_[^/]+\.(?:py|js|mjs|ts|tsx|rs)$|(?:^|\/)[^/]+(?:[._-](?:test|spec))\.(?:[cm]?[jt]sx?|py|rs)$/i;
const centralEntrypoint = /(?:^|\/)(?:\.github\/scripts\/central-ci|scripts\/central-ci(?:-[^/]+)?)\.(?:sh|ps1|mjs|js|ts)$/i;

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function parseOwnershipPolicy(value: unknown): OwnershipPolicy {
  if (!record(value) || value.schema_version !== 1 ||
      value.control_repository !== "fongap-labs/action-worker" ||
      !record(value.workflow_templates) || !Array.isArray(value.local_test_exceptions) ||
      Object.keys(value).sort().join(",") !==
        "control_repository,local_test_exceptions,schema_version,workflow_templates") {
    throw new CliError("Invalid central engineering ownership policy.", 65);
  }
  const templates = value.workflow_templates;
  if (Object.keys(templates).length === 0 ||
      !Object.entries(templates).every(([path, target]) =>
        workflowName.test(path) && typeof target === "string" &&
        /^templates\/bridge\/[A-Za-z0-9_.-]+\.yml$/.test(target))) {
    throw new CliError("Invalid trusted workflow template mapping.", 65);
  }
  const seen = new Set<string>();
  const exceptions: LocalException[] = [];
  for (const entry of value.local_test_exceptions) {
    if (!record(entry) || Object.keys(entry).sort().join(",") !== "path_prefix,reason,repository" ||
        typeof entry.repository !== "string" || !repositoryName.test(entry.repository) ||
        typeof entry.path_prefix !== "string" || !safePath.test(entry.path_prefix) ||
        !entry.path_prefix.endsWith("/") || typeof entry.reason !== "string" ||
        entry.reason.trim().length < 12 || entry.reason.length > 250) {
      throw new CliError("Invalid centrally approved local test exception.", 65);
    }
    const key = entry.repository + "/" + entry.path_prefix;
    if (seen.has(key)) throw new CliError("Duplicate local test exception.", 65);
    seen.add(key);
    exceptions.push({ repository: entry.repository, path_prefix: entry.path_prefix, reason: entry.reason });
  }
  return {
    schema_version: 1,
    control_repository: value.control_repository as string,
    workflow_templates: templates as Record<string, string>,
    local_test_exceptions: exceptions,
  };
}

export function inspectEngineeringOwnership(
  policy: OwnershipPolicy,
  repository: string,
  changes: readonly ChangedFile[],
  readChangedFile: (path: string) => string,
  readTrustedTemplate: (path: string) => string
): OwnershipFinding[] {
  if (!repositoryName.test(repository)) throw new CliError("Invalid target repository.", 65);
  if (repository === policy.control_repository) return [];
  const findings: OwnershipFinding[] = [];
  for (const change of changes) {
    const { status, path } = change;
    if (!safePath.test(path) || !["A", "M", "T"].includes(status)) {
      throw new CliError("Invalid git change entry.", 65);
    }
    if (workflowName.test(path)) {
      const template = policy.workflow_templates[path];
      if (!template) {
        findings.push({ code: "workflow-outside-control", path });
      } else if (readChangedFile(path) !== readTrustedTemplate(template)) {
        findings.push({ code: "workflow-template-mismatch", path });
      }
      continue;
    }
    if (status !== "A") continue; // Historic local suites are migration debt, not a permanent exemption.
    if (testFile.test(path) &&
        !policy.local_test_exceptions.some((entry) =>
          entry.repository === repository && path.startsWith(entry.path_prefix))) {
      findings.push({ code: "new-local-test", path });
    }
    if (centralEntrypoint.test(path)) {
      findings.push({ code: "new-local-ci-runner", path });
    }
  }
  return findings;
}

export function parseChangedFiles(output: string): ChangedFile[] {
  if (!output) return [];
  if (!output.endsWith("\0")) throw new CliError("Git changed-file output is incomplete.", 65);
  const fields = output.slice(0, -1).split("\0");
  if (fields.length % 2 !== 0) throw new CliError("Git changed-file output is malformed.", 65);
  const changes: ChangedFile[] = [];
  for (let i = 0; i < fields.length; i += 2) {
    const status = fields[i];
    const path = fields[i + 1];
    if (!path || (status !== "A" && status !== "M" && status !== "T")) {
      throw new CliError("Git changed-file status is invalid.", 65);
    }
    changes.push({ status, path });
  }
  return changes;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 5 * 1024 * 1024,
  });
}

export function runOwnershipGate(targetRoot: string, base: string, head: string, repository: string): void {
  if (!shaPattern.test(base) || !shaPattern.test(head)) {
    throw new CliError("Central engineering gate requires exact base/head commit SHAs.", 65);
  }
  const root = resolve(targetRoot);
  const controlRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const policy = parseOwnershipPolicy(JSON.parse(
    readFileSync(join(controlRoot, "policies", "engineering-ownership.json"), "utf8")
  ) as unknown);
  for (const sha of [base, head]) {
    git(root, ["cat-file", "-e", sha + "^{commit}"]);
  }
  const output = git(root, [
    "diff", "--no-ext-diff", "--no-textconv", "--no-renames",
    "--diff-filter=AMT", "--name-status", "-z", base, head, "--"
  ]);
  const changes = parseChangedFiles(output);
  const findings = inspectEngineeringOwnership(
    policy, repository, changes,
    (path) => git(root, ["show", head + ":" + path]),
    (path) => readFileSync(join(controlRoot, path), "utf8")
  );
  if (findings.length > 0) {
    const detail = process.env.TARGET_PRIVATE === "true"
      ? "Details withheld for private repository."
      : findings.map((item) => item.code + ": " + item.path).join("; ");
    throw new CliError("Central engineering ownership gate denied " +
      findings.length + " change(s). " + detail, 65);
  }
  console.log("Central engineering ownership gate passed (" + changes.length + " examined).");
}

if (isMain(import.meta.url)) {
  const [targetRoot, base, head, repository] = process.argv.slice(2);
  if (!targetRoot || !base || !head || !repository) {
    throw new CliError("Usage: central-engineering-gate.ts <target> <base-sha> <head-sha> <repository>", 64);
  }
  try {
    runOwnershipGate(targetRoot, base, head, repository);
  } catch (error) {
    handleError(error);
  }
}
