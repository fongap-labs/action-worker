import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { isJsonRecord } from "./github-api.ts";
import { appendLines, CliError, handleError, isMain } from "./runtime-command.ts";

// Prepare a freshly cloned target repository for a staged task publication:
//   1. enforce the target's own .github/output-retention.json by pruning the
//      oldest periods of the affected output project until the marker count fits;
//   2. sanitize the published manifest.json against the target's own
//      .github/manifest-allowlist.json (redact URLs in non-URL fields, then
//      fail closed on any remaining contract violation).
// Both policies are read from the target repository, so this script stays
// repository-agnostic. Usage: prepare-publication-target.ts <target_root> <dest_dir>

const RETENTION_CONFIG = join(".github", "output-retention.json");
const MANIFEST_ALLOWLIST = join(".github", "manifest-allowlist.json");
const MARKER_FILE = "manifest.json";
const URL_REDACTION = "[url-redacted]";

function normalizeDestDir(value: string): string {
  const destDir = value.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!destDir || destDir.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new CliError("::error::Publication destination is invalid.", 64);
  }
  return destDir;
}

type RetentionPolicy = {
  defaultPeriods: number;
  projects: Record<string, number>;
};

export function parseRetentionPolicy(value: unknown): RetentionPolicy {
  if (!isJsonRecord(value)) {
    throw new CliError("::error::Output retention config must be a JSON object.", 64);
  }
  const defaultPeriods = value.default_periods;
  const projects = value.projects;
  if (
    value.schema_version !== "1" ||
    typeof defaultPeriods !== "number" ||
    !Number.isInteger(defaultPeriods) ||
    defaultPeriods < 1 ||
    !isJsonRecord(projects)
  ) {
    throw new CliError("::error::Output retention config schema is invalid.", 64);
  }
  const parsed: Record<string, number> = {};
  for (const [key, limit] of Object.entries(projects)) {
    if (
      typeof limit !== "number" ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      key.split("/").some((part) => !part || part === "." || part === "..")
    ) {
      throw new CliError(`::error::Output retention config project entry is invalid: ${key}.`, 64);
    }
    parsed[key] = limit;
  }
  return { defaultPeriods, projects: parsed };
}

async function collectMarkers(dir: string, base = dir): Promise<string[]> {
  const found: string[] = [];
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await collectMarkers(path, base)));
    } else if (entry.isFile() && entry.name === MARKER_FILE) {
      found.push(relative(base, path).split(sep).join("/"));
    }
  }
  return found.sort();
}

export async function enforceRetention(
  targetRoot: string,
  destDir: string
): Promise<{ projectDir: string | null; pruned: string[] }> {
  const configPath = join(targetRoot, RETENTION_CONFIG);
  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch {
    return { projectDir: null, pruned: [] };
  }
  let policy: RetentionPolicy;
  try {
    policy = parseRetentionPolicy(JSON.parse(raw) as unknown);
  } catch (error) {
    if (error instanceof CliError) {
      throw new CliError(`::error::${RETENTION_CONFIG}: ${error.message}`, 64);
    }
    throw new CliError(`::error::${RETENTION_CONFIG} is not valid JSON.`, 64);
  }

  const segments = destDir.split("/");
  const projectDir = segments.length >= 2 ? segments.slice(0, 2).join("/") : destDir;
  const projectPath = join(targetRoot, projectDir);
  const limit = policy.projects[projectDir] ?? policy.defaultPeriods;

  const pruned: string[] = [];
  let markers = await collectMarkers(projectPath);
  while (markers.length > limit) {
    // markers are relative paths like <period>/<edition>/manifest.json; prune the
    // whole oldest period directory so the retention window keeps the newest periods.
    const oldestMarker = markers[0];
    if (!oldestMarker) {
      throw new CliError("::error::Retention marker path is invalid.", 64);
    }
    const oldestPeriod = oldestMarker.split("/")[0];
    if (!oldestPeriod) {
      throw new CliError("::error::Retention marker path is invalid.", 64);
    }
    const periodPath = join(projectPath, oldestPeriod);
    await rm(periodPath, { recursive: true, force: true });
    pruned.push(`${projectDir}/${oldestPeriod}`);
    markers = await collectMarkers(projectPath);
  }
  if (pruned.length > 0) {
    console.log(
      `prepare-publication-target: retention ${projectDir}: pruned ${pruned.join(", ")} (limit ${limit}, now ${markers.length} ${MARKER_FILE})`
    );
  }
  return { projectDir, pruned };
}

type Allowlist = {
  requiredRootKeys: string[];
  allowedKeys: string[];
  urlFields: Set<string>;
  urlRequiredFields: Set<string>;
  blacklistAll: [string, RegExp][];
  blacklistNonUrl: [string, RegExp][];
};

export function parseAllowlist(value: unknown): Allowlist {
  if (!isJsonRecord(value)) {
    throw new CliError("::error::Manifest allowlist must be a JSON object.", 64);
  }
  const asStringArray = (input: unknown): string[] =>
    Array.isArray(input) && input.every((item) => typeof item === "string")
      ? (input as string[])
      : [];
  const asRegexEntries = (input: unknown): [string, RegExp][] => {
    if (!isJsonRecord(input)) {
      return [];
    }
    const entries: [string, RegExp][] = [];
    for (const [name, pattern] of Object.entries(input)) {
      if (typeof pattern !== "string") {
        continue;
      }
      try {
        entries.push([name, new RegExp(pattern)]);
      } catch {
        throw new CliError(
          `::error::Manifest allowlist blacklist pattern is invalid: ${name}.`,
          64
        );
      }
    }
    return entries;
  };
  return {
    requiredRootKeys: asStringArray(value.required_root_keys),
    allowedKeys: asStringArray(value.allowed_keys),
    urlFields: new Set(asStringArray(value.url_fields)),
    urlRequiredFields: new Set(asStringArray(value.url_required_fields)),
    blacklistAll: asRegexEntries(value.blacklist_all),
    blacklistNonUrl: asRegexEntries(value.blacklist_non_url_fields),
  };
}

function redactUrls(node: unknown, field: string | null, urlFields: Set<string>): number {
  if (typeof node === "string") {
    if (field !== null && !urlFields.has(field)) {
      return node.replace(/https?:\/\/\S+/g, URL_REDACTION) === node ? 0 : 1;
    }
    return 0;
  }
  if (Array.isArray(node)) {
    let changed = 0;
    for (let index = 0; index < node.length; index += 1) {
      const before = node[index];
      if (typeof before === "string" && field !== null && !urlFields.has(field)) {
        const redacted = before.replace(/https?:\/\/\S+/g, URL_REDACTION);
        if (redacted !== before) {
          node[index] = redacted;
          changed += 1;
          continue;
        }
      }
      changed += redactUrls(before, field, urlFields);
    }
    return changed;
  }
  if (isJsonRecord(node)) {
    let changed = 0;
    for (const key of Object.keys(node)) {
      const before = node[key];
      if (typeof before === "string" && !urlFields.has(key)) {
        const redacted = before.replace(/https?:\/\/\S+/g, URL_REDACTION);
        if (redacted !== before) {
          node[key] = redacted;
          changed += 1;
          continue;
        }
      }
      changed += redactUrls(before, key, urlFields);
    }
    return changed;
  }
  return 0;
}

function collectViolations(
  node: unknown,
  path: string,
  field: string | null,
  allowlist: Allowlist,
  violations: string[]
): void {
  if (isJsonRecord(node)) {
    if (path === "") {
      for (const key of allowlist.requiredRootKeys) {
        if (!(key in node)) {
          violations.push(`root: missing required field(s): ${key}`);
        }
      }
    }
    for (const [key, value] of Object.entries(node)) {
      const childPath = path === "" ? key : `${path}/${key}`;
      if (allowlist.allowedKeys.length > 0 && !allowlist.allowedKeys.includes(key)) {
        violations.push(`field not in allowlist: ${childPath}`);
      }
      collectViolations(value, childPath, key, allowlist, violations);
    }
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      collectViolations(item, `${path}[]`, field, allowlist, violations);
    }
    return;
  }
  if (typeof node !== "string") {
    return;
  }
  const shown = node.replace(/[\n\r\t]/g, " ").slice(0, 160);
  for (const [name, regex] of allowlist.blacklistAll) {
    if (regex.test(node)) {
      violations.push(`blacklist_all.${name}: ${path}: ${shown}`);
    }
  }
  if (field !== null && !allowlist.urlFields.has(field)) {
    for (const [name, regex] of allowlist.blacklistNonUrl) {
      if (regex.test(node)) {
        violations.push(`blacklist_non_url_fields.${name}: ${path}: ${shown}`);
      }
    }
  }
  if (field !== null && allowlist.urlRequiredFields.has(field) && !/^https?:\/\//.test(node)) {
    violations.push(`url field must start with http(s)://: ${path}`);
  }
}

export async function sanitizeManifest(
  targetRoot: string,
  destDir: string
): Promise<{ changed: boolean; redactions: number }> {
  const allowlistPath = join(targetRoot, MANIFEST_ALLOWLIST);
  let allowlistRaw: string;
  try {
    allowlistRaw = await readFile(allowlistPath, "utf8");
  } catch {
    return { changed: false, redactions: 0 };
  }
  let allowlist: Allowlist;
  try {
    allowlist = parseAllowlist(JSON.parse(allowlistRaw) as unknown);
  } catch (error) {
    if (error instanceof CliError) {
      throw new CliError(`::error::${MANIFEST_ALLOWLIST}: ${error.message}`, 64);
    }
    throw new CliError(`::error::${MANIFEST_ALLOWLIST} is not valid JSON.`, 64);
  }

  const manifestPath = join(targetRoot, destDir, MARKER_FILE);
  let raw: string;
  try {
    raw = await readFile(manifestPath, "utf8");
  } catch {
    return { changed: false, redactions: 0 };
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(raw) as unknown;
  } catch {
    throw new CliError(
      `::error::Published ${MARKER_FILE} is not valid JSON: ${destDir}/${MARKER_FILE}`,
      66
    );
  }
  const redactions = redactUrls(manifest, null, allowlist.urlFields);
  const violations: string[] = [];
  collectViolations(manifest, "", null, allowlist, violations);
  if (violations.length > 0) {
    throw new CliError(
      `::error::Published ${MARKER_FILE} violates the target manifest contract (fail-closed): ${violations.slice(0, 5).join(" | ")}`,
      66
    );
  }
  const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
  if (serialized !== raw || !raw.endsWith("\n")) {
    await writeFile(manifestPath, serialized, "utf8");
    if (redactions > 0) {
      console.log(
        `prepare-publication-target: redacted ${redactions} URL(s) in non-URL field(s) of ${destDir}/${MARKER_FILE}`
      );
    }
    return { changed: serialized !== raw, redactions };
  }
  return { changed: false, redactions };
}

async function main(): Promise<void> {
  const [targetRootArg, destDirArg] = process.argv.slice(2);
  if (!targetRootArg || !destDirArg) {
    throw new CliError(
      "::error::Usage: prepare-publication-target.ts <target_root> <dest_dir>",
      64
    );
  }
  const targetRoot = targetRootArg;
  const destDir = normalizeDestDir(destDirArg);

  const retention = await enforceRetention(targetRoot, destDir);
  const manifest = await sanitizeManifest(targetRoot, destDir);

  await appendLines(process.env.GITHUB_OUTPUT, [
    `project_dir=${retention.projectDir ?? ""}`,
    `retention_pruned=${retention.pruned.length}`,
    `manifest_redactions=${manifest.redactions}`,
  ]);
  console.log("prepare-publication-target: target prepared.");
  if (retention.projectDir) {
    console.log(`PROJECT_DIR=${retention.projectDir}`);
  }
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
