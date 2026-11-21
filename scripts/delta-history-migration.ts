import { readFileSync } from "node:fs";
import {
  type GithubReader,
  getJsonArray,
  getJsonNumber,
  getJsonString,
  isJsonRecord,
} from "./github-api.ts";
import { CliError } from "./runtime-command.ts";

// This is NOT a general migration capability. Only the exact Delta repository, target SHA,
// and eight source snapshots may be accepted. A different migration requires new reviewed code.
const deltaRepository = "fongap-labs/delta";
const deltaTargetSha = "8b73554a94a115c3fc8310e882036ef887f0569c";
const policyPath = "policies/delta-history-migration.json";
const shaPattern = /^[a-f0-9]{40}$/;

type Snapshot = {
  source_sha: string;
  target_sha: string;
  tree_sha: string;
};

export type DeltaHistoryPolicy = {
  schema_version: 1;
  repository: string;
  approval_issue: number;
  source_pr: number;
  source_sha: string;
  target_sha: string;
  baseline_sha: string;
  tree_sha: string;
  source_backup_ref: string;
  target_ref: string;
  baseline_ref: string;
  upstream_ref: string;
  snapshots: Snapshot[];
};

export function isDeltaHistoryMigrationTarget(repository: string, sha: string): boolean {
  return repository === deltaRepository && sha === deltaTargetSha;
}

function deny(reason: string): never {
  throw new CliError(`::error::Delta history migration denied: ${reason}.`, 65);
}

function requireExact(isValid: boolean, reason: string): void {
  if (!isValid) deny(reason);
}

function hasSha(value: unknown): value is string {
  return typeof value === "string" && shaPattern.test(value);
}

/** A fixed policy committed through central PR governance, never from target repository code. */
export function readDeltaHistoryPolicy(): DeltaHistoryPolicy {
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(policyPath, "utf8")) as unknown;
  } catch {
    return deny("reviewed manifest is missing or invalid");
  }
  requireExact(isJsonRecord(data), "manifest is not an object");
  const record = data as Record<string, unknown>;
  requireExact(
    record.schema_version === 1 &&
      record.repository === deltaRepository &&
      record.target_sha === deltaTargetSha &&
      record.source_pr === 10 &&
      record.approval_issue === 1924 &&
      hasSha(record.source_sha) &&
      hasSha(record.baseline_sha) &&
      hasSha(record.tree_sha) &&
      record.source_backup_ref === "legacy/main-pre-harness-migration-2026-11-22-v2" &&
      record.target_ref === "migration/rebase-delta-on-harness-2026-11-22-v2" &&
      record.baseline_ref === "baseline/deepseek-harness" &&
      record.upstream_ref === "upstream/deepseek-harness" &&
      Array.isArray(record.snapshots) &&
      record.snapshots.length === 8,
    "manifest identity is not the approved Delta case"
  );
  const snapshots = record.snapshots as unknown[];
  for (const item of snapshots) {
    requireExact(
      isJsonRecord(item) &&
        hasSha(item.source_sha) &&
        hasSha(item.target_sha) &&
        hasSha(item.tree_sha),
      "manifest contains an invalid historical snapshot"
    );
  }
  const items = snapshots as Snapshot[];
  requireExact(
    items[items.length - 1]?.source_sha === record.source_sha &&
      items[items.length - 1]?.target_sha === record.target_sha &&
      items[items.length - 1]?.tree_sha === record.tree_sha &&
      new Set(items.map((item) => item.source_sha)).size === items.length &&
      new Set(items.map((item) => item.target_sha)).size === items.length,
    "manifest source, destination or snapshots disagree"
  );
  return record as DeltaHistoryPolicy;
}

export type DeltaMigrationStage = "preflight" | "cutover";

/**
 * Verify BOTH immutable commit chains and every original tree snapshot.
 * preflight: main remains at the governed original SHA;
 * cutover: main points to the exact prepared target.
 * No loose merge-base, branch name, commit message, or GitHub badge is a substitute.
 */
export async function verifyDeltaHistoryMigration(
  reader: Pick<GithubReader, "get">,
  repository: string,
  targetSha: string,
  stage: DeltaMigrationStage = "cutover"
): Promise<DeltaHistoryPolicy | null> {
  if (!isDeltaHistoryMigrationTarget(repository, targetSha)) return null;
  const policy = readDeltaHistoryPolicy();
  const prefix = `repos/${repository}`;

  const requiredRefs: Array<[string, string]> = [
    ["main", stage === "preflight" ? policy.source_sha : policy.target_sha],
    [policy.source_backup_ref, policy.source_sha],
    [policy.target_ref, policy.target_sha],
    [policy.baseline_ref, policy.baseline_sha],
    [policy.upstream_ref, policy.baseline_sha],
  ];
  for (const [ref, expected] of requiredRefs) {
    const response = await reader.get(`${prefix}/git/ref/heads/${ref}`);
    requireExact(
      getJsonString(isJsonRecord(response) ? response.object : null, "sha") === expected,
      `protected reference ${ref} is not at its pinned SHA`
    );
  }

  let previousSource = "";
  let previousTarget = policy.baseline_sha;
  for (const [i, snapshot] of policy.snapshots.entries()) {
    const [source, target] = await Promise.all([
      reader.get(`${prefix}/git/commits/${snapshot.source_sha}`),
      reader.get(`${prefix}/git/commits/${snapshot.target_sha}`),
    ]);
    const sourceParents = getJsonArray(source, "parents");
    const targetParents = getJsonArray(target, "parents");
    requireExact(
      getJsonString(source, "sha") === snapshot.source_sha &&
        getJsonString(target, "sha") === snapshot.target_sha &&
        getJsonString(isJsonRecord(source) ? source.tree : null, "sha") === snapshot.tree_sha &&
        getJsonString(isJsonRecord(target) ? target.tree : null, "sha") === snapshot.tree_sha &&
        sourceParents.length === (i === 0 ? 0 : 1) &&
        (i === 0 || getJsonString(sourceParents[0], "sha") === previousSource) &&
        targetParents.length === 1 &&
        getJsonString(targetParents[0], "sha") === previousTarget,
      `snapshot ${i + 1} changed content or parentage`
    );
    previousSource = snapshot.source_sha;
    previousTarget = snapshot.target_sha;
  }

  const compare = await reader.get(
    `${prefix}/compare/${policy.baseline_sha}...${policy.target_sha}`
  );
  requireExact(
    getJsonString(compare, "status") === "ahead" &&
      getJsonNumber(compare, "behind_by") === 0 &&
      getJsonNumber(compare, "ahead_by") === 8 &&
      getJsonString(isJsonRecord(compare) ? compare.merge_base_commit : null, "sha") ===
        policy.baseline_sha,
    "new history does not descend linearly from the exact Harness baseline"
  );

  return policy;
}
