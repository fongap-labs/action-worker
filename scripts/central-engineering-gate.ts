import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CliError, handleError, isMain } from "./runtime-command.ts";
import { ensureSourceImportAvailable, resolveSourceImportBase } from "./source-import-baselines.ts";

export type ChangedFile = { status: "A" | "M" | "T" | "D"; path: string; sha?: string };
// A single, verified package-identity migration from the exact accepted plugin baseline.
// New tests, changed test behavior, and CI launcher changes other than this literal rename
// still fail the normal ownership gate. The exception expires as soon as main advances.
export const PLUGIN_RENAME_BASES = new Set([
  "f6f265ae211cfa99830d214c3fba3319e5a5ce1c",
  "094ad41c4948155419eb12a53be6709d88272c3d",
]);
export const PLUGIN_RENAME_REPOSITORY = "fongap-labs/plugins";
const LEGACY_PLUGIN_PREFIX = ["dsh", "delta"].join("-") + "-";
const NEW_PLUGIN_TEST = /^tests\/delta-(?:code|desktop|suite)(?:-[a-z0-9-]+)?[.]test[.]mjs$/;
const EXISTING_PLUGIN_CI = new Set([
  ".github/scripts/central-ci.sh",
  "scripts/central-ci-windows.mjs",
]);

export function isPinnedPluginRenameCandidate(file: ChangedFile): boolean {
  return (
    (file.status === "A" && NEW_PLUGIN_TEST.test(file.path)) ||
    (file.status === "M" && EXISTING_PLUGIN_CI.has(file.path))
  );
}

export function filterVerifiedPluginNameOnlyChanges(
  files: readonly ChangedFile[],
  readAtRevision: (revision: "base" | "head", path: string) => Buffer
): ChangedFile[] {
  return files.filter((file) => {
    const renamedTest = file.status === "A" && NEW_PLUGIN_TEST.test(file.path);
    const existingCi = file.status === "M" && EXISTING_PLUGIN_CI.has(file.path);
    if (!renamedTest && !existingCi) return true;
    const oldPath = renamedTest ? "tests/dsh-" + file.path.slice("tests/".length) : file.path;
    const previous = readAtRevision("base", oldPath);
    const updated = readAtRevision("head", file.path);
    const decoded = previous.toString("utf8");
    // Invalid UTF-8 must not be normalized into an apparently valid source file.
    if (!Buffer.from(decoded, "utf8").equals(previous)) return true;
    return !Buffer.from(decoded.replaceAll(LEGACY_PLUGIN_PREFIX, "delta-"), "utf8").equals(updated);
  });
}

type LocalException = { repository: string; path_prefix: string; reason: string };
type PrivateWorkflowPin = { repository: string; path: string; blob_sha: string; reason: string };
export type OwnershipPolicy = {
  schema_version: 1;
  control_repository: string;
  workflow_templates: Record<string, string>;
  private_workflow_pins: PrivateWorkflowPin[];
  local_test_exceptions: LocalException[];
};
export type OwnershipFinding = { code: string; path: string };

const repositoryName = /^fongap-labs\/[A-Za-z0-9_.-]+$/;
const workflowName = /^\.github\/workflows\/[A-Za-z0-9_.-]+\.(?:yml|yaml)$/;
const safePath = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\\)[^\r\n\0]+$/;
const shaPattern = /^[0-9a-f]{40}$/;
const testFile =
  /(?:^|\/)(?:tests?|__tests__)\/|(?:^|\/)test_[^/]+\.(?:py|js|mjs|ts|tsx|rs)$|(?:^|\/)[^/]+(?:[._-](?:test|spec))\.(?:[cm]?[jt]sx?|py|rs)$/i;
const centralEntrypoint =
  /^(?:\.github\/scripts\/central-ci(?:-[^/]+)?|scripts\/(?:central-ci|build|check|test|lint|release|deploy|package|publish)(?:-[^/]+)?)\.(?:sh|ps1|mjs|js|ts|cjs|py)$/i;

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function parseOwnershipPolicy(value: unknown): OwnershipPolicy {
  if (
    !record(value) ||
    value.schema_version !== 1 ||
    value.control_repository !== "fongap-labs/action-worker" ||
    !record(value.workflow_templates) ||
    !Array.isArray(value.private_workflow_pins) ||
    !Array.isArray(value.local_test_exceptions) ||
    Object.keys(value).sort().join(",") !==
      "control_repository,local_test_exceptions,private_workflow_pins,schema_version,workflow_templates"
  ) {
    throw new CliError("Invalid central engineering ownership policy.", 65);
  }
  const templates = value.workflow_templates;
  if (
    Object.keys(templates).length === 0 ||
    !Object.entries(templates).every(
      ([path, target]) =>
        workflowName.test(path) &&
        typeof target === "string" &&
        /^templates\/bridge\/[A-Za-z0-9_.-]+\.yml$/.test(target)
    )
  ) {
    throw new CliError("Invalid trusted workflow template mapping.", 65);
  }
  const privatePins: PrivateWorkflowPin[] = [];
  const pinnedPaths = new Set<string>();
  for (const entry of value.private_workflow_pins) {
    if (
      !record(entry) ||
      Object.keys(entry).sort().join(",") !== "blob_sha,path,reason,repository" ||
      typeof entry.repository !== "string" ||
      !repositoryName.test(entry.repository) ||
      entry.repository === value.control_repository ||
      typeof entry.path !== "string" ||
      !workflowName.test(entry.path) ||
      Object.hasOwn(templates, entry.path) ||
      typeof entry.blob_sha !== "string" ||
      !shaPattern.test(entry.blob_sha) ||
      typeof entry.reason !== "string" ||
      entry.reason.trim().length < 12 ||
      entry.reason.length > 250
    ) {
      throw new CliError("Invalid private workflow blob pin.", 65);
    }
    const key = entry.repository + "/" + entry.path;
    if (pinnedPaths.has(key)) throw new CliError("Duplicate private workflow blob pin.", 65);
    pinnedPaths.add(key);
    privatePins.push({
      repository: entry.repository,
      path: entry.path,
      blob_sha: entry.blob_sha,
      reason: entry.reason,
    });
  }
  const seen = new Set<string>();
  const exceptions: LocalException[] = [];
  for (const entry of value.local_test_exceptions) {
    if (
      !record(entry) ||
      Object.keys(entry).sort().join(",") !== "path_prefix,reason,repository" ||
      typeof entry.repository !== "string" ||
      !repositoryName.test(entry.repository) ||
      typeof entry.path_prefix !== "string" ||
      !safePath.test(entry.path_prefix) ||
      !entry.path_prefix.endsWith("/") ||
      typeof entry.reason !== "string" ||
      entry.reason.trim().length < 12 ||
      entry.reason.length > 250
    ) {
      throw new CliError("Invalid centrally approved local test exception.", 65);
    }
    const key = entry.repository + "/" + entry.path_prefix;
    if (seen.has(key)) throw new CliError("Duplicate local test exception.", 65);
    seen.add(key);
    exceptions.push({
      repository: entry.repository,
      path_prefix: entry.path_prefix,
      reason: entry.reason,
    });
  }
  return {
    schema_version: 1,
    control_repository: value.control_repository as string,
    workflow_templates: templates as Record<string, string>,
    private_workflow_pins: privatePins,
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
    if (!safePath.test(path) || !["A", "M", "T", "D"].includes(status)) {
      throw new CliError("Invalid git change entry.", 65);
    }
    if (workflowName.test(path)) {
      const template = policy.workflow_templates[path];
      const privatePin = policy.private_workflow_pins.find(
        (pin) => pin.repository === repository && pin.path === path
      );
      if (status === "D") {
        if (template || privatePin) findings.push({ code: "required-workflow-deleted", path });
        continue; // Removing legacy workflows not owned by the central platform is encouraged.
      }
      if (privatePin) {
        // A pin can only review changes to an existing private workflow.
        // It never authorizes the creation of another execution entry point.
        if (status !== "M" || change.sha !== privatePin.blob_sha) {
          findings.push({ code: "private-workflow-blob-mismatch", path });
        }
      } else if (!template) {
        findings.push({ code: "workflow-outside-control", path });
      } else if (readChangedFile(path) !== readTrustedTemplate(template)) {
        findings.push({ code: "workflow-template-mismatch", path });
      }
      continue;
    }
    if (path === ".github/execution-manifest.json" && status === "D") {
      findings.push({ code: "execution-manifest-deleted", path });
    }
    // Legacy CI launchers remain available only until replaced with a central builder.
    // No business PR may silently weaken an existing launcher's checks.
    if (
      status !== "A" &&
      status !== "D" &&
      /^(?:\.github\/scripts\/central-ci(?:-[^/]+)?|scripts\/central-ci(?:-[^/]+)?)\.(?:sh|ps1|mjs|js|ts|cjs|py)$/i.test(
        path
      )
    ) {
      findings.push({ code: "project-owned-ci-control-modified", path });
    }
    if (status !== "A") continue; // Historic local suites are migration debt, not a permanent exemption.
    if (
      testFile.test(path) &&
      !policy.local_test_exceptions.some(
        (entry) => entry.repository === repository && path.startsWith(entry.path_prefix)
      )
    ) {
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
    if (!path || (status !== "A" && status !== "M" && status !== "T" && status !== "D")) {
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

// A one-time public source import replaces a bootstrap shell with a pinned
// upstream product tree. Historical upstream tests are not newly authored tests.
// Never use this comparison for an ordinary pull request.
export function centralOwnershipComparisonBase(base: string): string {
  return resolveSourceImportBase(base);
}

export function runOwnershipGate(
  targetRoot: string,
  base: string,
  head: string,
  repository: string
): void {
  if (!shaPattern.test(base) || !shaPattern.test(head)) {
    throw new CliError("Central engineering gate requires exact base/head commit SHAs.", 65);
  }
  const root = resolve(targetRoot);
  const controlRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const policy = parseOwnershipPolicy(
    JSON.parse(
      readFileSync(join(controlRoot, "policies", "engineering-ownership.json"), "utf8")
    ) as unknown
  );
  const comparisonBase = centralOwnershipComparisonBase(base);
  if (comparisonBase !== base) {
    const source = ensureSourceImportAvailable(root, base);
    if (source !== comparisonBase) {
      throw new CliError(
        "Pinned source-import baseline is unavailable for ownership comparison.",
        65
      );
    }
  }
  // Retain the verified bootstrap identity and fail closed if any pinned
  // commit or target revision is unavailable.
  for (const sha of new Set([base, comparisonBase, head])) {
    git(root, ["cat-file", "-e", sha + "^{commit}"]);
  }
  const output = git(root, [
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--no-renames",
    "--diff-filter=AMTD",
    "--name-status",
    "-z",
    comparisonBase,
    head,
    "--",
  ]);
  const changes = parseChangedFiles(output).map((change) => {
    const privatePin = policy.private_workflow_pins.some(
      (pin) => pin.repository === repository && pin.path === change.path
    );
    if (!privatePin || change.status === "D") return change;
    return { ...change, sha: git(root, ["rev-parse", head + ":" + change.path]).trim() };
  });
  let reviewedChanges = changes;
  if (
    repository === PLUGIN_RENAME_REPOSITORY &&
    PLUGIN_RENAME_BASES.has(base) &&
    process.env.TARGET_PRIVATE === "false" &&
    changes.some(isPinnedPluginRenameCandidate)
  ) {
    reviewedChanges = filterVerifiedPluginNameOnlyChanges(changes, (revision, path) =>
      execFileSync("git", ["-C", root, "show", (revision === "base" ? base : head) + ":" + path], {
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: 2 * 1024 * 1024,
        timeout: 10_000,
      })
    );
  }
  const findings = inspectEngineeringOwnership(
    policy,
    repository,
    reviewedChanges,
    (path) => git(root, ["show", head + ":" + path]),
    (path) => readFileSync(join(controlRoot, path), "utf8")
  );
  if (findings.length > 0) {
    const detail =
      process.env.TARGET_PRIVATE === "true"
        ? "Details withheld for private repository."
        : findings.map((item) => item.code + ": " + item.path).join("; ");
    throw new CliError(
      "Central engineering ownership gate denied " + findings.length + " change(s). " + detail,
      65
    );
  }
  console.log("Central engineering ownership gate passed (" + changes.length + " examined).");
}

if (isMain(import.meta.url)) {
  const [targetRoot, base, head, repository] = process.argv.slice(2);
  if (!targetRoot || !base || !head || !repository) {
    throw new CliError(
      "Usage: central-engineering-gate.ts <target> <base-sha> <head-sha> <repository>",
      64
    );
  }
  try {
    runOwnershipGate(targetRoot, base, head, repository);
  } catch (error) {
    handleError(error);
  }
}
