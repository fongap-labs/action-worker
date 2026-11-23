import {
  latestCiStatus,
  trustedControlRunId,
  type JsonReader,
} from "./ci-evidence.ts";
import { getJsonArray, getJsonString, isJsonRecord, statusAwareReader } from "./github-api.ts";
import { verifyMaintainerResolution } from "./historical-main-review.ts";
import { CliError, handleError, isMain } from "./runtime-command.ts";
import { hasValidStatusAttestation, originalStatusDescription } from "./status-attestation.ts";

const repository = "fongap-labs/delta";
const control = "fongap-labs/action-worker";
const rootIncident = "b6e23bae43976e28b7c3f46c6b65041900a777be";
const reviewedIssue = 87;

// One immutable, maintainer-resolved incident. No generic historical CI exemption.
export const reviewedDeltaCiCases = [
  {
    sha: rootIncident,
    parent: "96d36e875dcd24a28926b9993843ddac9ed11a8f",
    pr: 83,
  },
  {
    sha: "e56e125bff1db5aa4c776649b3461ea915ad2b45",
    parent: rootIncident,
    pr: 86,
  },
  {
    sha: "3effeb139e9af5198bfa5d380b1d3457caea4fcb",
    parent: "e56e125bff1db5aa4c776649b3461ea915ad2b45",
    pr: 88,
  },
] as const;

export function reviewedDeltaCiCase(target: string, sha: string) {
  return target === repository ? reviewedDeltaCiCases.find((item) => item.sha === sha) : undefined;
}

export async function verifyReviewedDeltaCiTarget(
  reader: Pick<JsonReader, "get">,
  target: string,
  sha: string,
  currentMainSha: string
): Promise<boolean> {
  const item = reviewedDeltaCiCase(target, sha);
  if (!item) return false;
  if (!/^[a-f0-9]{40}$/.test(currentMainSha)) {
    throw new CliError("Reviewed Delta CI requires an immutable current main SHA.", 65);
  }
  const commit = await reader.get(`repos/${repository}/commits/${sha}`);
  const parents = getJsonArray(commit, "parents");
  if (
    getJsonString(commit, "sha") !== sha ||
    parents.length !== 1 ||
    getJsonString(parents[0], "sha") !== item.parent
  ) {
    throw new CliError("Reviewed Delta historical commit ancestry is untrusted.", 65);
  }
  if (sha !== currentMainSha) {
    const compare = await reader.get(`repos/${repository}/compare/${sha}...${currentMainSha}`);
    if (
      getJsonString(compare, "status") !== "ahead" ||
      getJsonString(isJsonRecord(compare) ? compare.merge_base_commit : null, "sha") !== sha
    ) {
      throw new CliError("Historical Delta CI SHA is no longer on main ancestry.", 65);
    }
  }
  await verifyMaintainerResolution(reader, {
    repository,
    merge_sha: item.sha,
    root_incident_sha: rootIncident,
    pr_number: item.pr,
    approval_issue: reviewedIssue,
  });
  const combined = await reader.get(`repos/${repository}/commits/${sha}/status`);
  const guard = latestCiStatus(combined, "Main Write Guard");
  if (
    getJsonString(guard, "state") !== "success" ||
    !hasValidStatusAttestation(guard, { repository, sha, context: "Main Write Guard" }) ||
    !originalStatusDescription(guard).includes(`via PR #${item.pr}`)
  ) {
    throw new CliError("Historical Delta CI requires a verified, approved main-write guard.", 65);
  }
  return true;
}

export async function needsReviewedDeltaCi(
  reader: Pick<JsonReader, "get">,
  targetSha: string,
  currentControlSha: string
): Promise<boolean> {
  if (!/^[a-f0-9]{40}$/.test(currentControlSha)) return false;
  const combined = await reader.get(`repos/${repository}/commits/${targetSha}/status`);
  const current = latestCiStatus(combined, "CI Evidence");
  if (!current) return true;
  const state = getJsonString(current, "state");
  if (state === "success") return false;
  if (
    !["failure", "error", "pending"].includes(state) ||
    !hasValidStatusAttestation(current, {
      repository,
      sha: targetSha,
      context: "CI Evidence",
    })
  ) {
    return false;
  }
  const id = trustedControlRunId(getJsonString(current, "target_url"), control);
  if (!id) return false;
  const run = await reader.get(`repos/${control}/actions/runs/${id}`);
  return (
    getJsonString(run, "status") === "completed" &&
    getJsonString(run, "head_branch") === "main" &&
    getJsonString(run, "head_sha") !== currentControlSha &&
    getJsonString(isJsonRecord(run) ? run.repository : null, "full_name") === control &&
    [
      ".github/workflows/central-ci-dispatch.yml",
      ".github/workflows/intake.yml",
    ].includes(getJsonString(run, "path"))
  );
}

async function main(): Promise<void> {
  const [target = "", sha = "", current = ""] = process.argv.slice(2);
  const controlToken = process.env.AW_CONTROL_TOKEN ?? "";
  const statusToken = process.env.AW_STATUS_API_TOKEN ?? "";
  if (!controlToken || !statusToken) throw new CliError("Scoped CI verification tokens missing.", 77);
  const reader = statusAwareReader(
    process.env.GITHUB_API_URL ?? "https://api.github.com",
    controlToken,
    statusToken
  );
  const passed = await verifyReviewedDeltaCiTarget(reader, target, sha, current);
  console.log(passed ? "true" : "false");
}

if (isMain(import.meta.url)) main().catch(handleError);
