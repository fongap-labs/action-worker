import { readFile } from "node:fs/promises";
import { hasTrustedSuccessfulCiEvidence } from "./ci-evidence.ts";
import { requireToken } from "./control-token.ts";
import {
  getGithubJson,
  getJsonArray,
  getJsonString,
  githubExists,
  isJsonRecord,
  runGithubCli,
} from "./github-api.ts";
import { CliError, handleError, isMain } from "./runtime-command.ts";
import { isReviewComplete } from "./validate-review-result.ts";

const marker = "<!-- action-worker-pr-governance -->";
const mergeBlockedLabel = "merge-blocked";

export function requiresMergeBlockedLabel(status: string): boolean {
  return status !== "success";
}

export type MergeDisplayGate = {
  current: boolean;
  status: "success" | "failure";
};

// The label and comment are advisory and must follow the current PR head rather than a stale
// workflow's claimed verdict. The authoritative merge guard independently verifies each run.
export function evaluateMergeDisplayGate(
  pull: unknown,
  combinedStatus: unknown,
  expectedHeadSha: string,
  controlRepository: string
): MergeDisplayGate {
  const currentHead =
    isJsonRecord(pull) && isJsonRecord(pull.head) ? getJsonString(pull.head, "sha") : "";
  if (!/^[0-9a-f]{40}$/.test(expectedHeadSha) || currentHead !== expectedHeadSha) {
    return { current: false, status: "failure" };
  }

  const allGatesPassed = ["PR Governance", "CI Evidence", "validate-merge"].every((context) =>
    hasTrustedSuccessfulCiEvidence(combinedStatus, context, controlRepository)
  );
  return { current: true, status: allGatesPassed ? "success" : "failure" };
}

async function syncMergeBlockedLabel(
  repository: string,
  prNumber: string,
  status: string,
  token: string
): Promise<void> {
  const issueLabel = `repos/${repository}/issues/${prNumber}/labels/${mergeBlockedLabel}`;
  if (!requiresMergeBlockedLabel(status)) {
    if (await githubExists(issueLabel, token)) {
      await runGithubCli(["api", "--method", "DELETE", issueLabel], token);
    }
    return;
  }

  const repositoryLabel = `repos/${repository}/labels/${mergeBlockedLabel}`;
  if (!(await githubExists(repositoryLabel, token))) {
    await runGithubCli(
      [
        "api",
        "--method",
        "POST",
        `repos/${repository}/labels`,
        "-f",
        `name=${mergeBlockedLabel}`,
        "-f",
        "color=B60205",
        "-f",
        "description=Central merge gate is not yet successful",
      ],
      token
    );
  }
  if (!(await githubExists(issueLabel, token))) {
    await runGithubCli(
      [
        "api",
        "--method",
        "POST",
        `repos/${repository}/issues/${prNumber}/labels`,
        "-f",
        `labels[]=${mergeBlockedLabel}`,
      ],
      token
    );
  }
}

async function optionalJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

export function buildReview(
  status: string,
  runUrl: string,
  planValue: unknown,
  resultValue: unknown,
  isReviewQueued = false,
  deployGapHint = "",
  isReviewFinished = false
): string {
  const gate =
    status === "success"
      ? "PASS"
      : status === "awaiting-approval"
        ? "WAITING FOR APPROVAL"
        : "FAIL";
  const lines = [marker, "## PR Governance", "", `- Gate: **${gate}**`];
  if (requiresMergeBlockedLabel(status)) {
    lines.push(
      "- **DO NOT MERGE:** The current PR head is not authorized for merging. Wait until `PR Governance`, `CI Evidence`, and `validate-merge` are all successful on the exact current commit. GitHub may still show the Merge button for private repositories without enforceable branch protection."
    );
  }
  if (status === "awaiting-approval") {
    lines.push(
      "- Why: the author has no write access, so Central CI runs this code only after a maintainer approves the current head commit.",
      "- Next step: a maintainer opens **Files changed → Review changes → Approve**. Nothing else is needed: Action Worker continues automatically after the approval on its next Intake run, usually within an hour; any push to main of a managed repository starts that run at once.",
      "- A new push needs a new approval."
    );
  }
  lines.push("- AI Review role: advisory only; findings do not determine the gate.");
  if (isJsonRecord(planValue)) {
    const context = isJsonRecord(planValue.context) ? planValue.context : {};
    const triage = isJsonRecord(planValue.triage) ? planValue.triage : {};
    lines.push(`- Risk: \`${getJsonString(context, "risk") || "unknown"}\``);
    lines.push(
      `- Triage: \`${getJsonString(triage, "status") || "not-run"} / ${getJsonString(triage, "action") || "keep"}\``
    );
    lines.push(`- Review: \`${getJsonString(planValue, "review_agent") || "none"}\``);
    const model = getJsonString(planValue, "review_model");
    if (model) {
      lines.push(`- Model: \`${model}\``);
    }
  }
  if (isReviewComplete(resultValue) && isJsonRecord(resultValue)) {
    const comments = Array.isArray(resultValue.comments)
      ? resultValue.comments.filter(isJsonRecord)
      : [];
    const countSeverity = (severity: string): number =>
      comments.filter((item) => getJsonString(item, "severity").toLowerCase() === severity).length;
    lines.push(
      `- AI Review: **COMPLETE**`,
      `- Findings: ${comments.length} (critical ${countSeverity("critical")} · high ${countSeverity("high")} · medium ${countSeverity("medium")} · low ${countSeverity("low")})`
    );
    lines.push("");
    if (comments.length > 0) {
      lines.push("### Findings", "");
      for (const comment of comments.slice(0, 40)) {
        const severity = (getJsonString(comment, "severity") || "unknown").toUpperCase();
        const path = getJsonString(comment, "path") || "?";
        const line =
          typeof comment.start_line === "number"
            ? comment.start_line
            : typeof comment.end_line === "number"
              ? comment.end_line
              : 0;
        const category = getJsonString(comment, "category") || "other";
        const content = getJsonString(comment, "content")
          .replace(/[\r\n]+/g, " ")
          .slice(0, 600);
        lines.push(`- **${severity}** \`${path}:${line}\` [${category}] — ${content}`);
      }
      if (comments.length > 40) {
        lines.push(
          "",
          "_Only the first 40 findings are shown; see the Action Worker run for the complete result._"
        );
      }
    } else {
      lines.push("AI Review found no issues.");
    }
  } else if (isReviewQueued) {
    lines.push(
      "- AI Review: queued; this comment is updated when it finishes and it does not affect the merge gate."
    );
  } else if (isReviewFinished || (isJsonRecord(planValue) && planValue.review_required === true)) {
    lines.push(
      "- AI Review: **FAILED or incomplete**; no successful AI assessment is available. Check the linked review run. The merge gate is unaffected."
    );
  }
  if (deployGapHint?.trim()) {
    lines.push(deployGapHint.trim());
  }
  lines.push("", `[Action Worker run](${runUrl})`);
  return `${lines.join("\n")}\n`;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length < 6 || args.length > 8) {
    throw new CliError(
      "Usage: publish-pr-review.ts <repository> <pr-number> <status> <run-url> <plan-file> <result-file> [queued] [deploy-gap-hint]",
      64
    );
  }
  const [
    repository = "",
    prNumber = "",
    rawStatus = "",
    runUrl = "",
    planPath = "",
    resultPath = "",
    reviewState = "",
    deployGapHint = "",
  ] = args;
  if (!["", "queued", "finished"].includes(reviewState)) {
    throw new CliError(`::error::Invalid AI Review state: ${reviewState}.`, 64);
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new CliError(`::error::Invalid repository: ${repository}.`, 64);
  }
  if (!/^[1-9][0-9]*$/.test(prNumber)) {
    throw new CliError(`::error::Invalid PR number: ${prNumber}.`, 64);
  }
  const token = requireToken("issue");
  const controlToken = process.env.AW_CONTROL_TOKEN ?? "";
  const controlRepository = process.env.GITHUB_REPOSITORY ?? "";
  const expectedHeadSha = process.env.HEAD_SHA ?? "";
  if (!controlToken || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(controlRepository)) {
    throw new CliError(
      "::error::PR review publication requires issue and control credentials.",
      77
    );
  }
  if (!/^[0-9a-f]{40}$/.test(expectedHeadSha)) {
    throw new CliError("::error::PR review publication requires the exact head SHA.", 64);
  }

  const pull = await getGithubJson(`repos/${repository}/pulls/${prNumber}`, controlToken);
  const combinedStatus = await getGithubJson(
    `repos/${repository}/commits/${expectedHeadSha}/status`,
    controlToken
  );
  const gate = evaluateMergeDisplayGate(pull, combinedStatus, expectedHeadSha, controlRepository);
  if (!gate.current) {
    console.log(
      `::notice::PR review publication skipped for a stale head: ${repository}#${prNumber}@${expectedHeadSha}.`
    );
    return;
  }
  const status =
    gate.status === "success"
      ? "success"
      : rawStatus === "awaiting-approval"
        ? "awaiting-approval"
        : "failure";
  if (rawStatus === "success" && status !== "success") {
    console.warn(
      `::warning::PR review cannot claim success without current-head central gates: ${repository}#${prNumber}.`
    );
  }
  const body = buildReview(
    status,
    runUrl,
    await optionalJson(planPath),
    await optionalJson(resultPath),
    reviewState === "queued",
    deployGapHint,
    reviewState === "finished"
  );
  // This label is a visible warning only. The verified commit statuses remain authoritative;
  // label API failures must never accidentally authorize a merge or conceal the gate comment.
  try {
    await syncMergeBlockedLabel(repository, prNumber, status, token);
  } catch (error) {
    console.warn(
      `::warning::Could not synchronize advisory ${mergeBlockedLabel} label for ${repository}#${prNumber}: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  const commentsText = await runGithubCli(
    [
      "api",
      "--paginate",
      "--slurp",
      `repos/${repository}/issues/${prNumber}/comments?per_page=100`,
    ],
    token
  );
  const pages = JSON.parse(commentsText) as unknown;
  const comments = Array.isArray(pages)
    ? pages.flatMap((page) => (Array.isArray(page) ? page : []))
    : getJsonArray(pages);
  const current = comments.find(
    (item) => isJsonRecord(item) && getJsonString(item, "body").includes(marker)
  );
  const commentId =
    isJsonRecord(current) && typeof current.id === "number" ? String(current.id) : "";
  // A passing gate with no requested AI review needs no comment. A queued or finished review
  // always publishes its outcome, including failure and zero findings.
  if (!commentId && status === "success" && reviewState === "") {
    console.log(`PR governance passed; no comment needed: ${repository}#${prNumber}`);
    return;
  }
  if (commentId) {
    await runGithubCli(
      [
        "api",
        "--method",
        "PATCH",
        `repos/${repository}/issues/comments/${commentId}`,
        "-f",
        `body=${body}`,
      ],
      token
    );
    console.log(`PR governance comment updated: ${repository}#${prNumber}`);
  } else {
    await runGithubCli(
      [
        "api",
        "--method",
        "POST",
        `repos/${repository}/issues/${prNumber}/comments`,
        "-f",
        `body=${body}`,
      ],
      token
    );
    console.log(`PR governance comment created: ${repository}#${prNumber}`);
  }
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
