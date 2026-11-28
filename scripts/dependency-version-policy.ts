import { isJsonRecord } from "./github-api.ts";
import { CliError } from "./runtime-command.ts";

type DependencyClass = "toolchain" | "engineering" | "framework" | "project";
type Branch = "main" | "dev";
type CatalogEntry = { class: DependencyClass; version: string | null };
type Exception = {
  repository: string;
  branch: Branch;
  dependency: string;
  declaration: string;
  reason: string;
  expires_on: string;
};
export type DependencyPolicy = {
  schema_version: 1;
  mode: "advisory" | "ratchet";
  default_class: "project";
  catalog: Map<string, CatalogEntry>;
  exceptions: Exception[];
};
export type DeclarationStatus = "matching" | "different" | "range-review" | "excepted" | "observe";

const keyPattern = /^(?:tool|npm|python|cargo):(?:@[\w.-]+\/)?[\w.-]+$/;
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const versionPattern = /^\d+\.\d+(?:\.\d+)?$/;
const declarationPattern = /^(?=.*\d)[\dA-Za-z.*^~<>=!|,+ -]{1,120}$/;
const classes = new Set<string>(["toolchain", "engineering", "framework", "project"]);

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return (
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
  );
}

function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + "T00:00:00Z");
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function invalid(): never {
  throw new CliError("Central dependency version policy is invalid.", 65);
}

export function parseDependencyPolicy(value: unknown, organization: string): DependencyPolicy {
  if (
    !isJsonRecord(value) ||
    !exactKeys(value, ["schema_version", "mode", "default_class", "catalog", "exceptions"]) ||
    value.schema_version !== 1 ||
    (value.mode !== "advisory" && value.mode !== "ratchet") ||
    value.default_class !== "project" ||
    !isJsonRecord(value.catalog) ||
    Object.keys(value.catalog).length === 0 ||
    !Array.isArray(value.exceptions) ||
    !/^[A-Za-z0-9_.-]+$/.test(organization)
  ) {
    invalid();
  }
  const catalog = new Map<string, CatalogEntry>();
  for (const [key, entry] of Object.entries(value.catalog)) {
    if (
      !keyPattern.test(key) ||
      !isJsonRecord(entry) ||
      !exactKeys(entry, ["class", "version"]) ||
      typeof entry.class !== "string" ||
      !classes.has(entry.class) ||
      (entry.version !== null &&
        (typeof entry.version !== "string" || !versionPattern.test(entry.version))) ||
      (entry.class !== "toolchain" && entry.class !== "engineering" && entry.version !== null) ||
      key.startsWith("tool:") !== (entry.class === "toolchain")
    ) {
      invalid();
    }
    catalog.set(key, { class: entry.class as DependencyClass, version: entry.version });
  }

  const exceptions: Exception[] = [];
  const identities = new Set<string>();
  for (const item of value.exceptions) {
    if (
      !isJsonRecord(item) ||
      !exactKeys(item, [
        "repository",
        "branch",
        "dependency",
        "declaration",
        "reason",
        "expires_on",
      ]) ||
      typeof item.repository !== "string" ||
      !repositoryPattern.test(item.repository) ||
      !item.repository.startsWith(organization + "/") ||
      (item.branch !== "main" && item.branch !== "dev") ||
      typeof item.dependency !== "string" ||
      catalog.get(item.dependency)?.version == null ||
      typeof item.declaration !== "string" ||
      !declarationPattern.test(item.declaration) ||
      typeof item.reason !== "string" ||
      item.reason.trim().length === 0 ||
      item.reason.length > 500 ||
      !validDate(item.expires_on)
    ) {
      invalid();
    }
    const identity = JSON.stringify([
      item.repository,
      item.branch,
      item.dependency,
      item.declaration,
    ]);
    if (identities.has(identity)) invalid();
    identities.add(identity);
    exceptions.push({
      repository: item.repository,
      branch: item.branch,
      dependency: item.dependency,
      declaration: item.declaration,
      reason: item.reason,
      expires_on: item.expires_on,
    });
  }
  return {
    schema_version: 1,
    mode: value.mode,
    default_class: "project",
    catalog,
    exceptions,
  };
}

export function parseNpmAlias(specifier: string): { key: string; version: string } | null {
  if (specifier.length > 120) return null;
  const match = /^npm:((?:@[\w.-]+\/)?[\w.-]+)@((?=.*\d)[\dA-Za-z.*^~<>=!|,+ -]+)$/.exec(
    specifier
  );
  if (!match?.[1] || !match[2]) return null;
  return { key: "npm:" + match[1], version: match[2] };
}

export function evaluateDeclaration(
  policy: DependencyPolicy,
  repository: string,
  branch: Branch,
  key: string,
  version: string,
  today: string
): DeclarationStatus {
  if (!validDate(today)) invalid();
  const target = policy.catalog.get(key)?.version;
  if (target == null) return "observe";
  const alias = key.startsWith("npm:") ? parseNpmAlias(version) : null;
  if (alias && alias.key !== key) return "range-review";
  if (
    alias === null &&
    policy.exceptions.some(
      (item) =>
        item.repository === repository &&
        item.branch === branch &&
        item.dependency === key &&
        item.declaration === version &&
        item.expires_on >= today
    )
  ) {
    return "excepted";
  }
  version = alias?.version ?? version;
  if (!versionPattern.test(version)) return "range-review";
  if (version === target) return "matching";
  // A two-part baseline describes a minor series, not an exact patch.
  if (target.split(".").length === 2 && version.startsWith(target + ".")) return "matching";
  return "different";
}
