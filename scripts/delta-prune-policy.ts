import { createHash } from "node:crypto";
import { isJsonRecord } from "./github-api.ts";
import { CliError } from "./runtime-command.ts";

const listKeys = [
  "allowedProducts",
  "allowedCapabilities",
  "allowedEntrypoints",
  "allowedArtifacts",
  "deniedCapabilities",
  "deniedPackages",
  "deniedDependencies",
] as const;
const keys = new Set<string>(["version", ...listKeys, "exceptions", "thresholds"]);
const identifier = /^[A-Za-z0-9@._:/-]{1,256}$/;

type ListKey = (typeof listKeys)[number];
type PolicyException = {
  scope: string;
  reason: string;
  approval: string;
  expiresAt: string;
};
export type DeltaPrunePolicy = Record<ListKey, string[]> & {
  version: string;
  exceptions: PolicyException[];
  thresholds: Record<string, number>;
};

function invalid(): never {
  throw new CliError("Delta pruning policy is missing, expired or invalid.", 65);
}

function exactId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    identifier.test(value) &&
    !value.split("/").some((part) => part === "." || part === "..")
  );
}

function list(value: unknown, required: boolean): string[] {
  if (!Array.isArray(value) || (required && value.length === 0)) invalid();
  if (!value.every(exactId) || new Set(value).size !== value.length) invalid();
  return [...value].sort();
}

function detail(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 512;
}

/** Validate the central Variable. This does not authorize a change or apply an exception. */
export function parseDeltaPrunePolicy(
  raw: string | undefined,
  now: number
): { policy: DeltaPrunePolicy; digest: string } {
  if (!raw || !Number.isFinite(now) || Buffer.byteLength(raw) > 48 * 1024) invalid();
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    invalid();
  }
  if (
    !isJsonRecord(value) ||
    Object.keys(value).length !== keys.size ||
    Object.keys(value).some((key) => !keys.has(key)) ||
    !exactId(value.version) ||
    !Array.isArray(value.exceptions) ||
    !isJsonRecord(value.thresholds)
  ) {
    invalid();
  }
  const lists = Object.fromEntries(
    listKeys.map((key) => [key, list(value[key], key.startsWith("allowed"))])
  ) as Record<ListKey, string[]>;
  if (lists.allowedCapabilities.some((id) => lists.deniedCapabilities.includes(id))) invalid();
  const exceptions: PolicyException[] = [];
  for (const entry of value.exceptions) {
    if (
      !isJsonRecord(entry) ||
      Object.keys(entry).length !== 4 ||
      !exactId(entry.scope) ||
      !detail(entry.reason) ||
      !detail(entry.approval) ||
      typeof entry.expiresAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(entry.expiresAt)
    ) {
      invalid();
    }
    const expiry = Date.parse(entry.expiresAt);
    if (
      !Number.isFinite(expiry) ||
      new Date(expiry).toISOString() !== entry.expiresAt ||
      expiry <= now ||
      exceptions.some((item) => item.scope === entry.scope)
    ) {
      invalid();
    }
    exceptions.push({
      scope: entry.scope,
      reason: entry.reason,
      approval: entry.approval,
      expiresAt: entry.expiresAt,
    });
  }
  exceptions.sort((a, b) => (a.scope < b.scope ? -1 : a.scope > b.scope ? 1 : 0));
  const thresholdEntries = Object.entries(value.thresholds).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0
  );
  const thresholds: Record<string, number> = Object.fromEntries(
    thresholdEntries.map(([key, amount]) => {
      if (
        !exactId(key) ||
        typeof amount !== "number" ||
        !Number.isFinite(amount) ||
        amount < 0
      ) {
        invalid();
      }
      return [key, amount];
    })
  );
  const policy: DeltaPrunePolicy = {
    version: value.version,
    ...lists,
    exceptions,
    thresholds,
  };
  const digest = createHash("sha256").update(JSON.stringify(policy)).digest("hex");
  return { policy, digest };
}
