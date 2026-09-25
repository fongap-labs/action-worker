import { readFile } from "node:fs/promises";
import {
  getJsonArray,
  getJsonString,
  isJsonRecord,
  runGithubCli,
} from "./github-api.ts";
import {
  CliError,
  handleError,
  isMain,
} from "./runtime-command.ts";

const marker = "<!-- action-worker-pr-governance -->";

async function optionalJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

export function buildReview(status: string, runUrl: string, planValue: unknown, resultValue: unknown): string {
  const lines = [marker, "## PR Governance", "", `- Gate: **${status === "success" ? "PASS" : "FAIL"}**`];
  if (isJsonRecord(planValue)) {
    const context = isJsonRecord(planValue.context) ? planValue.context : {};
    const triage = isJsonRecord(planValue.triage) ? planValue.triage : {};
    lines.push(`- Risk: \`${getJsonString(context, "risk") || "unknown"}\``);
    lines.push(`- Triage: \`${getJsonString(triage, "status") || "not-run"} / ${getJsonString(triage, "action") || "keep"}\``);
    lines.push(`- Review: \`${getJsonString(planValue, "review_agent") || "none"}\``);
    const model = getJsonString(planValue, "review_model");
    if (model) {
      lines.push(`- Model: \`${model}\``);
    }
    lines.push(`- AI Review: **ADVISORY**`);
    lines.push(`- Attention threshold: \`${getJsonString(planValue, "block_severity") || "none"}\``);
  }
  if (isJsonRecord(resultValue) && (resultValue.comments === undefined || Array.isArray(resultValue.comments))) {
    const comments = Array.isArray(resultValue.comments) ? resultValue.comments.filter(isJsonRecord) : [];
    const countSeverity = (severity: string): number => comments.filter((item) => getJsonString(item, "severity").toLowerCase() === severity).length;
    lines.push(`- Findings: ${comments.length} (critical ${countSeverity("critical")} · high ${countSeverity("high")} · medium ${countSeverity("medium")} · low ${countSeverity("low")})`);
    lines.push("");
    if (comments.length > 0) {
      lines.push("### Findings", "");
      for (const comment of comments.slice(0, 40)) {
        const severity = (getJsonString(comment, "severity") || "unknown").toUpperCase();
        const path = getJsonString(comment, "path") || "?";
        const line = typeof comment.start_line === "number" ? comment.start_line : typeof comment.end_line === "number" ? comment.end_line : 0;
        const category = getJsonString(comment, "category") || "other";
        const content = getJsonString(comment, "content").replace(/[\r\n]+/g, " ").slice(0, 600);
        lines.push(`- **${severity}** \`${path}:${line}\` [${category}] — ${content}`);
      }
      if (comments.length > 40) {
        lines.push("", "_Only the first 40 findings are shown; see the Action Worker run for the complete result._");
      }
    } else {
      lines.push("AI Review found no issues.");
    }
  } else if (status === "success") {
    const isReviewRequired = isJsonRecord(planValue) && planValue.review_required === true;
    lines.push(isReviewRequired ? "- AI Review: skipped (disabled)" : "- AI Review: policy skipped");
  } else {
    lines.push("", "Governance failed before a complete AI Review result was produced; inspect the Action Worker run.");
  }
  lines.push("", `[Action Worker run](${runUrl})`);
  return `${lines.join("\n")}\n`;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 6) {
    throw new CliError("Usage: publish-pr-review.ts <repository> <pr-number> <status> <run-url> <plan-file> <result-file>", 64);
  }
  const [repository = "", prNumber = "", rawStatus = "", runUrl = "", planPath = "", resultPath = ""] = args;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new CliError(`::error::Invalid repository: ${repository}.`, 64);
  }
  if (!/^[1-9][0-9]*$/.test(prNumber)) {
    throw new CliError(`::error::Invalid PR number: ${prNumber}.`, 64);
  }
  const token = process.env.GH_TOKEN ?? "";
  if (!token) {
    throw new CliError("::error::GH_TOKEN is required.");
  }
  const status = ["success", "failure", "cancelled"].includes(rawStatus) ? rawStatus : "failure";
  const body = buildReview(status, runUrl, await optionalJson(planPath), await optionalJson(resultPath));
  const commentsText = await runGithubCli(["api", "--paginate", "--slurp", `repos/${repository}/issues/${prNumber}/comments?per_page=100`], token);
  const pages = JSON.parse(commentsText) as unknown;
  const comments = Array.isArray(pages) ? pages.flatMap((page) => Array.isArray(page) ? page : []) : getJsonArray(pages);
  const current = comments.find((item) => isJsonRecord(item) && getJsonString(item, "body").includes(marker));
  const commentId = isJsonRecord(current) && typeof current.id === "number" ? String(current.id) : "";
  if (commentId) {
    await runGithubCli(["api", "--method", "PATCH", `repos/${repository}/issues/comments/${commentId}`, "-f", `body=${body}`], token);
    console.log(`PR governance comment updated: ${repository}#${prNumber}`);
  } else {
    await runGithubCli(["api", "--method", "POST", `repos/${repository}/issues/${prNumber}/comments`, "-f", `body=${body}`], token);
    console.log(`PR governance comment created: ${repository}#${prNumber}`);
  }
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
