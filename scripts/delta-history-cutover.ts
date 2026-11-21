import { isDeepStrictEqual } from "node:util";
import { rulesetPayloads } from "./apply-repository-settings.ts";
import { controlRepositoryOf, hasVerifiedCiEvidence } from "./ci-evidence.ts";
import { readDeltaHistoryPolicy, verifyDeltaHistoryMigration } from "./delta-history-migration.ts";
import { type GithubReader, getJsonString, isJsonRecord, statusAwareReader } from "./github-api.ts";
import { assertTrustedMainWrite, validateMainWriteProvenance } from "./main-write-guard.ts";
import { CliError, handleError, isMain, readJson, runText } from "./runtime-command.ts";

const targetRepository = "fongap-labs/delta";
const mainRulesetId = 26704813;
const sourceSha = "4870259d11d8468d6d494f9d609e70c148416cf8";
const targetSha = "8b73554a94a115c3fc8310e882036ef887f0569c";

type CutoverOperations = {
  preflight: () => Promise<void>;
  verifyTarget: () => Promise<void>;
  getMainSha: () => Promise<string>;
  disableProtection: () => Promise<void>;
  restoreProtection: () => Promise<void>;
  writeMain: (sha: string) => Promise<void>;
};

/**
 * A bounded one-time transaction. It never updates any arbitrary reference.
 * Retest the old SHA after protection is disabled; on a failed validation,
 * restore the original source SHA before restoring the ruleset.
 */
export async function performDeltaHistoryCutover(ops: CutoverOperations): Promise<void> {
  await ops.preflight();
  if ((await ops.getMainSha()) !== sourceSha) {
    throw new CliError("::error::Delta main moved before the cutover.", 65);
  }
  let hasProtectionAttempted = false;
  try {
    hasProtectionAttempted = true;
    await ops.disableProtection();
    if ((await ops.getMainSha()) !== sourceSha) {
      throw new CliError("::error::Delta main moved while the protection changed.", 65);
    }
    await ops.writeMain(targetSha);
    if ((await ops.getMainSha()) !== targetSha) {
      throw new CliError("::error::Delta main did not reach the exact migration SHA.", 65);
    }
    await ops.verifyTarget();
  } catch (error) {
    if (hasProtectionAttempted && (await ops.getMainSha()) === targetSha) {
      // An invalid or partially verified migration must not strand an untrusted main.
      await ops.writeMain(sourceSha);
    }
    throw error;
  } finally {
    if (hasProtectionAttempted) {
      // A separate always() workflow job also reapplies the full managed policy.
      await ops.restoreProtection();
    }
  }
}

async function ghJson(
  method: "GET" | "PUT" | "PATCH",
  path: string,
  token: string,
  body?: unknown
): Promise<unknown> {
  const args = [
    "api",
    "--method",
    method,
    "-H",
    "Accept: application/vnd.github+json",
    "-H",
    "X-GitHub-Api-Version: 2022-11-28",
    path,
  ];
  if (body !== undefined) args.push("--input", "-");
  const output = await runText("gh", args, {
    input: body === undefined ? undefined : JSON.stringify(body),
    env: { ...process.env, GH_TOKEN: token },
    timeoutMs: 30_000,
  });
  return output ? (JSON.parse(output) as unknown) : {};
}

async function getMainSha(token: string): Promise<string> {
  const result = await ghJson("GET", `repos/${targetRepository}/git/ref/heads/main`, token);
  return getJsonString(isJsonRecord(result) ? result.object : null, "sha");
}

async function loadManagedMainRuleset(token: string): Promise<{
  id: number;
  desired: Record<string, unknown>;
}> {
  const policy = await readJson("policies/rulesets.json");
  const desired = rulesetPayloads(policy).find((item) => item.name === "Protect Main Branch");
  if (!desired || desired.enforcement !== "active" || desired.bypass_actors.length !== 0) {
    throw new CliError("::error::Missing strict main ruleset policy.", 65);
  }
  const response = await ghJson(
    "GET",
    `repos/${targetRepository}/rulesets/${mainRulesetId}?includes_parents=false`,
    token
  );
  if (!isJsonRecord(response) || response.id !== mainRulesetId) {
    throw new CliError("::error::Pinned Delta ruleset identity mismatch.", 65);
  }
  const actual = {
    name: response.name,
    target: response.target,
    enforcement: response.enforcement,
    bypass_actors: response.bypass_actors ?? [],
    conditions: response.conditions,
    rules: response.rules,
  };
  if (!isDeepStrictEqual(actual, desired)) {
    throw new CliError("::error::Delta main protection deviates from central policy.", 65);
  }
  return { id: mainRulesetId, desired };
}

async function preflight(reader: GithubReader): Promise<void> {
  const policy = readDeltaHistoryPolicy();
  if (
    policy.repository !== targetRepository ||
    policy.source_sha !== sourceSha ||
    policy.target_sha !== targetSha
  ) {
    throw new CliError("::error::Delta migration inputs are not the approved immutable case.", 65);
  }
  await verifyDeltaHistoryMigration(reader, targetRepository, targetSha, "preflight");
  const source = await assertTrustedMainWrite(reader, targetRepository, sourceSha, true);
  if (source.pr_number !== policy.source_pr) {
    throw new CliError("::error::Original main PR identity is not preserved.", 65);
  }
  const statuses = await reader.get(`repos/${targetRepository}/commits/${sourceSha}/status`);
  if (
    !(await hasVerifiedCiEvidence(reader, statuses, {
      controlRepository: controlRepositoryOf(),
      targetRepository,
      targetSha: sourceSha,
      runAttempts: 1,
      retryDelayMs: 0,
    }))
  ) {
    throw new CliError("::error::Original main lacks completed signed CI Evidence.", 65);
  }
}

async function confirm(reader: GithubReader): Promise<void> {
  await verifyDeltaHistoryMigration(reader, targetRepository, targetSha, "cutover");
  const source = await assertTrustedMainWrite(reader, targetRepository, targetSha, true);
  if (source.source !== "delta-history-migration") {
    throw new CliError("::error::Delta target SHA has unexpected provenance.", 65);
  }
}

async function main(): Promise<void> {
  const mode = process.argv[2] ?? "";
  if (!["preflight", "cutover", "confirm"].includes(mode)) {
    throw new CliError("::error::Expected preflight, cutover, or confirm mode.", 64);
  }
  const readToken = process.env.AW_CONTROL_TOKEN ?? "";
  const statusToken = process.env.AW_STATUS_API_TOKEN ?? "";
  if (!readToken || !statusToken || !process.env.AW_STATUS_KEYRING) {
    throw new CliError(
      "::error::Distinct central read/status identities and keyring required.",
      77
    );
  }
  const reader = statusAwareReader("https://api.github.com", readToken, statusToken);
  if (mode === "preflight") {
    await preflight(reader);
    console.log("Delta migration preflight verified: exact refs, eight snapshots, signed source.");
    return;
  }
  if (mode === "confirm") {
    await confirm(reader);
    console.log("Delta migration confirmed by signed Main Write Guard.");
    return;
  }
  const adminToken = process.env.AW_ADMIN_TOKEN ?? "";
  if (!adminToken) throw new CliError("::error::Admin environment token missing.", 77);
  // Validate all source evidence before inspecting or modifying branch protection.
  await preflight(reader);
  const { desired } = await loadManagedMainRuleset(adminToken);
  const endpoint = `repos/${targetRepository}/rulesets/${mainRulesetId}`;
  await performDeltaHistoryCutover({
    preflight: async () => await preflight(reader),
    verifyTarget: async () => {
      await verifyDeltaHistoryMigration(reader, targetRepository, targetSha, "cutover");
      const proof = await validateMainWriteProvenance(reader, targetRepository, targetSha, true);
      if (proof.source !== "delta-history-migration") {
        throw new CliError("::error::Migration provenance was not established.", 65);
      }
    },
    getMainSha: async () => await getMainSha(adminToken),
    disableProtection: async () => {
      await ghJson("PUT", endpoint, adminToken, { ...desired, enforcement: "disabled" });
    },
    restoreProtection: async () => {
      await ghJson("PUT", endpoint, adminToken, desired);
      // Verify the canonical policy, not merely a successful HTTP response.
      await loadManagedMainRuleset(adminToken);
    },
    writeMain: async (sha) => {
      await ghJson("PATCH", `repos/${targetRepository}/git/refs/heads/main`, adminToken, {
        sha,
        force: true,
      });
    },
  });
  console.log("Delta main moved to the exact verified Harness-descendant SHA; ruleset restored.");
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
