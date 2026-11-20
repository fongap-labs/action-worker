import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isApprovedCompletedMerge } from "./auto-merge-pr.ts";
import { hasVerifiedCiEvidence, trustedControlRunId } from "./ci-evidence.ts";
import {
  type GithubReader,
  getGithubJsonIfExists,
  getJsonArray,
  getJsonString,
  isJsonRecord,
  statusAwareReader,
} from "./github-api.ts";
import { hasVerifiedMainWriteGuard } from "./main-write-guard.ts";
import { readRepositoryPolicyText, validateRepositoryCapability } from "./repository-policy.ts";
import { appendLines, CliError, handleError, isMain, parseJson } from "./runtime-command.ts";
import { latestAttestedStatus } from "./status-attestation.ts";

const SHA = /^[0-9a-f]{40}$/;
const REPOSITORY = /^[a-z0-9-]{1,39}\/[a-z0-9_.-]{1,100}$/;
const PROPOSAL_BRANCH = /^chore\/skill-proposal-([0-9a-f]{20})$/;
const PROPOSAL_TITLE = "chore(delta-code): stage verified free Skill proposal";

export interface SkillAdmissionTarget {
  repository: string;
  proposal_prefix: string;
  catalog_path: string;
  enabled: boolean;
  max_closed_prs: number;
}

export interface SkillPromotionCandidate {
  targetRepository: string;
  proposalPrNumber: number;
  expectedProposalHead: string;
  mergeCommit: string;
  proposalPath: string;
  identity: string;
  source: {
    repository: string;
    path: string;
    commit: string;
    sourceBlobSha: string;
    licenseBlobSha: string;
  };
}

/** A versioned policy, not workflow input or an environment-granted repository. */
export function parseSkillAdmissionPolicy(raw: unknown): SkillAdmissionTarget[] {
  if (
    !isJsonRecord(raw) ||
    raw.schema_version !== 1 ||
    !Array.isArray(raw.targets) ||
    raw.targets.length < 1 ||
    raw.targets.length > 8
  ) {
    throw new CliError("Invalid Skill admission policy.", 65);
  }
  const seen = new Set<string>();
  const targets: SkillAdmissionTarget[] = [];
  for (const item of raw.targets) {
    if (
      !isJsonRecord(item) ||
      Object.keys(item).sort().join(",") !==
        "catalog_path,enabled,max_closed_prs,proposal_prefix,repository" ||
      typeof item.repository !== "string" ||
      !REPOSITORY.test(item.repository) ||
      typeof item.proposal_prefix !== "string" ||
      !/^packages\/[a-z0-9/-]+\/$/.test(item.proposal_prefix) ||
      typeof item.catalog_path !== "string" ||
      !/^packages\/[a-z0-9/-]+\.ts$/.test(item.catalog_path) ||
      typeof item.enabled !== "boolean" ||
      !Number.isSafeInteger(item.max_closed_prs) ||
      Number(item.max_closed_prs) < 1 ||
      Number(item.max_closed_prs) > 100 ||
      seen.has(item.repository)
    ) {
      throw new CliError("Invalid or duplicate Skill admission target.", 65);
    }
    seen.add(item.repository);
    targets.push(item as unknown as SkillAdmissionTarget);
  }
  return targets;
}

export function pinnedSkillProposalIdentity(source: unknown): string {
  if (
    !isJsonRecord(source) ||
    typeof source.repository !== "string" ||
    !REPOSITORY.test(source.repository) ||
    typeof source.path !== "string" ||
    !/^skills\/[a-z0-9-]+\/SKILL\.md$/.test(source.path) ||
    !["commit", "sourceBlobSha", "licenseBlobSha"].every(
      (key) => typeof source[key] === "string" && SHA.test(source[key] as string)
    )
  ) {
    throw new CliError("Invalid pinned Skill source.", 65);
  }
  const parts = [
    source.repository.toLowerCase(),
    source.path,
    source.commit,
    source.sourceBlobSha,
    source.licenseBlobSha,
  ] as string[];
  return createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 20);
}

function verifiedManifestSource(
  manifest: unknown,
  identity: string
): SkillPromotionCandidate["source"] {
  if (
    !isJsonRecord(manifest) ||
    Object.keys(manifest).sort().join(",") !==
      "approvalRequired,autoEnabled,executable,schemaVersion,source,state,staticAudit" ||
    manifest.schemaVersion !== 1 ||
    manifest.state !== "pending-ci-review" ||
    manifest.approvalRequired !== true ||
    manifest.autoEnabled !== false ||
    manifest.executable !== false ||
    !isJsonRecord(manifest.source) ||
    !isJsonRecord(manifest.staticAudit) ||
    Object.keys(manifest.source).sort().join(",") !==
      "commit,license,licenseBlobSha,path,repository,sourceBlobSha" ||
    ![
      "MIT",
      "Apache-2.0",
      "BSD-2-Clause",
      "BSD-3-Clause",
      "ISC",
      "MPL-2.0",
      "GPL-2.0-only",
      "GPL-3.0-only",
      "LGPL-2.1-only",
      "LGPL-3.0-only",
      "AGPL-3.0-only",
      "Unlicense",
      "CC0-1.0",
      "CC-BY-4.0",
    ].includes(getJsonString(manifest.source, "license")) ||
    Object.keys(manifest.staticAudit).sort().join(",") !==
      "freeUseEvidence,riskIndicators,status" ||
    manifest.staticAudit.status !== "static-review-ready" ||
    manifest.staticAudit.freeUseEvidence !== true ||
    !Array.isArray(manifest.staticAudit.riskIndicators) ||
    manifest.staticAudit.riskIndicators.length !== 0 ||
    pinnedSkillProposalIdentity(manifest.source) !== identity
  ) {
    throw new CliError("Skill proposal manifest has unverified free/safety evidence.", 65);
  }
  return {
    repository: getJsonString(manifest.source, "repository"),
    path: getJsonString(manifest.source, "path"),
    commit: getJsonString(manifest.source, "commit"),
    sourceBlobSha: getJsonString(manifest.source, "sourceBlobSha"),
    licenseBlobSha: getJsonString(manifest.source, "licenseBlobSha"),
  };
}

/**
 * Call only with fresh PR, signed commit status, and precise PR file metadata.
 * Unrelated and modified PRs are never candidates. Any malformed or forged
 * proposal is rejected instead of silently trusted.
 */
export function verifyMergedSkillProposal(
  pr: unknown, statuses: unknown, files: unknown, manifest: unknown,
  target: SkillAdmissionTarget, mergedGuard: unknown, controlRepository: string,
): SkillPromotionCandidate | null {
  if (!isJsonRecord(pr) || getJsonString(pr, "title") !== PROPOSAL_TITLE) return null;
  const head = isJsonRecord(pr.head) ? pr.head : {};
  const base = isJsonRecord(pr.base) ? pr.base : {};
  const match = PROPOSAL_BRANCH.exec(getJsonString(head, "ref"));
  if (!match || getJsonString(base, "ref") !== "main" ||
      getJsonString(head.repo, "full_name") !== target.repository ||
      getJsonString(base.repo, "full_name") !== target.repository ||
      !SHA.test(getJsonString(head, "sha")) ||
      !SHA.test(getJsonString(pr, "merge_commit_sha")) ||
      !SHA.test(getJsonString(base, "sha")) ||
      !Number.isSafeInteger(pr.number) || Number(pr.number) < 1) {
    throw new CliError("Skill proposal branch, target, or merged commit is invalid.", 65);
  }
  const sha = getJsonString(head, "sha");
  const governance = latestAttestedStatus(statuses, {
    repository: target.repository, sha, context: "PR Governance",
  });
  const governanceUrl = getJsonString(governance, "target_url");
  if (!trustedControlRunId(governanceUrl, controlRepository) ||
      !isApprovedCompletedMerge(
        pr, statuses, target.repository, Number(pr.number), sha,
        getJsonString(base, "sha"), governanceUrl
      )) {
    throw new CliError("Skill proposal lacks signed, completed PR governance and CI.", 65);
  }
  const guard = latestAttestedStatus(mergedGuard, {
    repository: target.repository,
    sha: getJsonString(pr, "merge_commit_sha"),
    context: "Main Write Guard",
  });
  if (guard?.state !== "success") {
    throw new CliError("Merged Skill proposal lacks signed Main Write Guard.", 75);
  }
  if (!Array.isArray(files) || files.length !== 2 ||
      !files.every(isJsonRecord)) {
    throw new CliError("Skill proposal must change exactly its manifest and CHANGELOG.", 65);
  }
  const identity = match[1];
  if (!identity) throw new CliError("Skill proposal identity missing.", 65);
  const source = verifiedManifestSource(manifest, identity);
  const skillName = source.path.split("/")[1];
  if (!skillName) throw new CliError("Skill proposal source name is missing.", 65);
  const manifestPath = target.proposal_prefix + skillName + "-" + identity + ".json";
  const expected = new Map([
    ["CHANGELOG.md", "modified"], [manifestPath, "added"],
  ]);
  if (!files.every(file =>
    expected.get(getJsonString(file, "filename")) === getJsonString(file, "status")
  ) || new Set(files.map(file => getJsonString(file, "filename"))).size !== 2) {
    throw new CliError("Skill proposal has unexpected code or file changes.", 65);
  }
  return {
    targetRepository: target.repository, proposalPrNumber: Number(pr.number),
    expectedProposalHead: sha, mergeCommit: getJsonString(pr, "merge_commit_sha"),
    proposalPath: manifestPath, identity, source,
  };
}

export async function inspectSkillProposals(
  reader: GithubReader, target: SkillAdmissionTarget,
  controlRepository: string,
): Promise<SkillPromotionCandidate | undefined> {
  const closed = getJsonArray(await reader.get(
    "repos/" + target.repository + "/pulls?state=closed&sort=updated&direction=desc&per_page=" +
    target.max_closed_prs
  ));
  // One promotion per invocation: the next intake heartbeat handles the next.
  for (const summary of closed) {
    if (!isJsonRecord(summary) ||
        getJsonString(summary, "title") !== PROPOSAL_TITLE ||
        summary.merged_at == null) continue;
    const number = summary.number;
    if (!Number.isSafeInteger(number) || Number(number) < 1) continue;
    const pr = await reader.get("repos/" + target.repository + "/pulls/" + number);
    if (!isJsonRecord(pr) || pr.merged !== true || !isJsonRecord(pr.head)) continue;
    const head = getJsonString(pr.head, "sha");
    if (!SHA.test(head)) throw new CliError("Merged Skill proposal SHA is invalid.", 65);
    const merge = getJsonString(pr, "merge_commit_sha");
    if (!SHA.test(merge)) throw new CliError("Merged Skill proposal identity is invalid.", 65);
    const statuses = await reader.get("repos/" + target.repository + "/commits/" + head + "/status");
    const mergedGuard = await reader.get("repos/" + target.repository + "/commits/" + merge + "/status");
    const files = getJsonArray(await reader.get(
      "repos/" + target.repository + "/pulls/" + number + "/files?per_page=100"
    ));
    const manifestFile = files.filter(isJsonRecord).find(file =>
      typeof file.filename === "string" &&
      file.filename.startsWith(target.proposal_prefix) &&
      file.filename.endsWith(".json")
    );
    if (!manifestFile) throw new CliError("Skill proposal manifest was not included in PR.", 65);
    const manifestPath = getJsonString(manifestFile, "filename");
    if (!/^packages\/[a-z0-9-/]+\/[a-z0-9-]+\.json$/.test(manifestPath)) {
      throw new CliError("Unsafe Skill proposal manifest path.", 65);
    }
    const content = await reader.get(
      "repos/" + target.repository + "/contents/" + manifestPath +
      "?ref=" + merge
    );
    if (!isJsonRecord(content) || content.encoding !== "base64" ||
        typeof content.content !== "string" || Number(content.size) > 16384) {
      throw new CliError("Incomplete bounded merged Skill proposal manifest.", 65);
    }
    let manifest: unknown;
    try {
      manifest = JSON.parse(Buffer.from(content.content.replace(/\s/g, ""), "base64").toString("utf8"));
    } catch {
      throw new CliError("Invalid immutable Skill proposal JSON.", 65);
    }
    const candidate = verifyMergedSkillProposal(
      pr, statuses, files, manifest, target, mergedGuard, controlRepository
    );
    if (!candidate) continue;
    if (!(await hasVerifiedMainWriteGuard(
      reader, mergedGuard, target.repository, merge
    ))) {
      throw new CliError("Merged Skill proposal has no verified trusted Main Write Guard.", 75);
    }
    // GitHub may delete a branch after merge; an old promotion PR remains
    // an immutable idempotency receipt even when the branch no longer exists.
    // A closed rejected PR also blocks retries: unexpected partial writes
    // require a new explicit revision, never a blind second promotion.
    const promoteBranch = "chore/skill-promote-" + candidate.identity;
    const owner = target.repository.split("/")[0];
    if (!owner) throw new CliError("Missing owner-bound Skill promotion target.", 65);
    const historical = getJsonArray(await reader.get(
      "repos/" + target.repository + "/pulls?state=all&per_page=100&base=main&head=" +
      encodeURIComponent(owner + ":" + promoteBranch)
    ));
    if (historical.length >= 100) {
      throw new CliError("Skill promotion history is not exhaustively bounded.", 75);
    }
    if (historical.some(pr => isJsonRecord(pr) &&
      getJsonString(pr.head, "ref") === promoteBranch &&
      getJsonString(isJsonRecord(pr.head) ? pr.head.repo : null, "full_name") ===
        target.repository)) continue;
    const branchPath = "repos/" + target.repository +
      "/git/ref/heads/" + promoteBranch;
    // A partial existing branch is not retried or overwritten. Manual incident
    // repair is safer than blindly issuing the same remote writes again.
    if (await getGithubJsonIfExists(branchPath, path => reader.get(path)) !== undefined) continue;
    if (!(await hasVerifiedCiEvidence(reader, statuses, {
      controlRepository, targetRepository: target.repository, targetSha: head,
      workflowPaths: [".github/workflows/central-ci-dispatch.yml"],
      runAttempts: 1, retryDelayMs: 0,
    }))) {
      throw new CliError("Skill proposal CI evidence does not match a completed trusted CI run.", 75);
    }
    return candidate;
  }
  return undefined;
}

async function main(): Promise<void> {
  const raw = readFileSync("policies/skill-admission.json", "utf8");
  const targets = parseSkillAdmissionPolicy(parseJson(raw, "Skill admission policy is invalid.", 65));
  const repositoryPolicy = parseJson(readRepositoryPolicyText(), "Repository policy is invalid.", 65);
  const controlRepository = process.env.GITHUB_REPOSITORY ?? "";
  const targetName = process.env.AW_INTAKE_TARGET_REPOSITORY ?? "";
  const controlToken = process.env.AW_CONTROL_TOKEN ?? "";
  const statusToken = process.env.AW_STATUS_API_TOKEN ?? "";
  if (!controlToken || !statusToken || !process.env.AW_STATUS_KEYRING ||
      !REPOSITORY.test(controlRepository)) {
    throw new CliError("Missing independent scoped Skill promotion read credentials.", 77);
  }
  if (targetName && !targets.some(target => target.repository === targetName)) {
    console.log("Unrelated intake target; no Skill promotion required.");
    await appendLines(process.env.GITHUB_OUTPUT, ["eligible=false"]);
    return;
  }
  const reader = statusAwareReader(
    process.env.GITHUB_API_URL ?? "https://api.github.com",
    controlToken, statusToken
  );
  for (const target of targets) {
    if (!target.enabled || (targetName && target.repository !== targetName)) continue;
    validateRepositoryCapability(target.repository, repositoryPolicy, "pr");
    if (target.repository.split("/")[0] !== controlRepository.split("/")[0]) {
      throw new CliError("Cross-owner Skill promotion is forbidden.", 77);
    }
    const candidate = await inspectSkillProposals(reader, target, controlRepository);
    if (!candidate) continue;
    const pluginMain = await reader.get("repos/" + target.repository + "/commits/main");
    if (!isJsonRecord(pluginMain) || !SHA.test(getJsonString(pluginMain, "sha"))) {
      throw new CliError("Managed plugin main revision is unavailable.", 65);
    }
    const pluginMainSha = getJsonString(pluginMain, "sha");
    const pluginGuard = await reader.get(
      "repos/" + target.repository + "/commits/" + pluginMainSha + "/status"
    );
    if (!(await hasVerifiedMainWriteGuard(
      reader, pluginGuard, target.repository, pluginMainSha
    ))) {
      throw new CliError("Plugin source code has no verified current Main Write Guard.", 75);
    }
    await appendLines(process.env.GITHUB_OUTPUT, [
      "eligible=true",
      "plugin_main_sha=" + pluginMainSha,
      "target_repository=" + candidate.targetRepository,
      "proposal_number=" + candidate.proposalPrNumber,
      "proposal_head=" + candidate.expectedProposalHead,
      "proposal_merge=" + candidate.mergeCommit,
      "source_repository=" + candidate.source.repository,
      "source_path=" + candidate.source.path,
      "source_commit=" + candidate.source.commit,
      "source_blob=" + candidate.source.sourceBlobSha,
      "license_blob=" + candidate.source.licenseBlobSha,
      "proposal_identity=" + candidate.identity,
    ]);
    console.log("Verified merged, signed, CI-approved free Skill proposal.");
    return;
  }
  await appendLines(process.env.GITHUB_OUTPUT, ["eligible=false"]);
  console.log("No eligible merged Skill proposals.");
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
