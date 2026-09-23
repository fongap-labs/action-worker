import { readFile, writeFile } from "node:fs/promises";
import {
  CliError,
  appendLines,
  handleError,
  isMain,
  parseJson,
} from "./runtime-command.ts";
import { isJsonRecord } from "./github-api.ts";

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown, message: string): JsonRecord {
  if (!isJsonRecord(value)) {
    throw new CliError(message, 65);
  }
  return value;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number {
  return typeof value === "number" ? value : Number.NaN;
}

function isDecision(value: unknown): value is JsonRecord {
  if (!isJsonRecord(value)) {
    return false;
  }
  return typeof value.review_required === "boolean"
    && ["code", "workflow", "release", "security", "architecture"].includes(asString(value.review_agent))
    && ["low", "medium", "high"].includes(asString(value.risk))
    && ["normal", "deep"].includes(asString(value.depth))
    && Number.isFinite(asNumber(value.confidence))
    && asNumber(value.confidence) >= 0
    && asNumber(value.confidence) <= 1;
}

export function applyTriage(
  planValue: unknown,
  triageValue: unknown,
  triagePolicy: unknown,
  reviewPolicy: unknown,
): JsonRecord {
  const plan = structuredClone(asRecord(planValue, "ERROR: invalid base plan."));
  const context = asRecord(plan.context, "ERROR: invalid base plan.");
  if (
    typeof plan.review_required !== "boolean"
    || typeof plan.review_agent !== "string"
    || !Array.isArray(context.change_areas)
    || !Array.isArray(context.declared_impacts)
  ) {
    throw new CliError("ERROR: invalid base plan.", 65);
  }

  const triage = asRecord(triagePolicy, "ERROR: invalid triage policy.");
  const review = asRecord(reviewPolicy, "ERROR: invalid review policy.");
  const skipConfidence = asNumber(triage.min_skip_confidence);
  const deepConfidence = asNumber(triage.min_deep_confidence);
  const deepModel = asString(triage.deep_model);
  if (
    !Number.isFinite(skipConfidence) || skipConfidence < 0 || skipConfidence > 1
    || !Number.isFinite(deepConfidence) || deepConfidence < 0 || deepConfidence > 1
    || !deepModel
  ) {
    throw new CliError("ERROR: invalid triage confidence policy.", 65);
  }

  const triageResult = isJsonRecord(triageValue) ? triageValue : {};
  let triageStatus = asString(triageResult.status) || "unavailable";
  const decision = triageResult.decision;
  if (triageStatus === "complete" && !isDecision(decision)) {
    triageStatus = "unavailable";
  }

  let action = "keep";
  if (triageStatus === "complete" && plan.review_required === true && isDecision(decision)) {
    const baseAgent = asString(plan.review_agent);
    const decisionAgent = asString(decision.review_agent);
    const decisionRisk = asString(decision.risk);
    const decisionDepth = asString(decision.depth);
    const confidence = asNumber(decision.confidence);
    const safeAreas = context.change_areas.length > 0
      && context.change_areas.every((area) => area === "source" || area === "test");
    const hasImpacts = context.declared_impacts.length > 0;
    const canSkip = baseAgent === "code"
      && safeAreas
      && !hasImpacts
      && decision.review_required === false
      && decisionRisk === "low"
      && confidence >= skipConfidence;

    if (canSkip) {
      Object.assign(plan, {
        review_required: false,
        review_agent: "none",
        review_model: "",
        review_rule: "",
        review_llm_timeout: 0,
        review_task_timeout: 0,
        review_concurrency: 0,
        review_resume_attempts: 0,
        review_resume_backoff_seconds: 0,
        review_effort: "low",
        block_severity: "none",
      });
      action = "skip";
    } else {
      let selectedAgent = baseAgent;
      if (decisionAgent === "security" || decisionAgent === "architecture") {
        selectedAgent = decisionAgent;
      } else if ((decisionAgent === "workflow" || decisionAgent === "release") && baseAgent === "code") {
        selectedAgent = decisionAgent;
      }
      if (selectedAgent !== baseAgent) {
        const agents = asRecord(review.agents, "ERROR: invalid review policy.");
        const selected = asRecord(agents[selectedAgent], "ERROR: triage selected an unconfigured review agent.");
        const model = asString(selected.model);
        const effort = asString(selected.effort);
        const rule = asString(selected.rule);
        if (!model || !effort || !rule) {
          throw new CliError("ERROR: triage selected an unconfigured review agent.", 65);
        }
        Object.assign(plan, {
          review_agent: selectedAgent,
          review_model: model,
          review_effort: effort,
          review_rule: rule,
        });
        action = "upgrade";
      }
      if (["security", "architecture"].includes(decisionAgent) || decisionRisk === "high") {
        if (plan.block_severity === "none" || plan.block_severity === "critical") {
          plan.block_severity = "high";
        }
      }
      if ((decisionDepth === "deep" || decisionRisk === "high") && confidence >= deepConfidence) {
        plan.review_model = deepModel;
        plan.review_effort = "high";
        if (action === "keep") {
          action = "deepen";
        }
      }
    }
  }

  plan.triage = { status: triageStatus, action, result: triageResult };
  return plan;
}

async function main(): Promise<void> {
  const paths = process.argv.slice(2);
  if (paths.length !== 4) {
    throw new CliError("Usage: apply-ai-triage.ts <base-plan-file> <triage-result-file> <triage-policy-file> <review-policy-file>", 64);
  }
  const [planPath = "", resultPath = "", triagePath = "", reviewPath = ""] = paths;
  let resultText = '{"status":"skipped","reason":"not_run"}';
  try {
    resultText = await readFile(resultPath, "utf8");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }
  try {
    const output = applyTriage(
      parseJson(await readFile(planPath, "utf8"), "ERROR: invalid base plan."),
      parseJson(resultText, "ERROR: invalid triage result."),
      parseJson(await readFile(triagePath, "utf8"), "ERROR: invalid triage policy."),
      parseJson(await readFile(reviewPath, "utf8"), "ERROR: invalid review policy."),
    );
    const json = JSON.stringify(output);
    if (process.env.GITHUB_OUTPUT) {
      await writeFile("/tmp/pr-plan.json", `${json}\n`, "utf8");
      await appendLines(process.env.GITHUB_OUTPUT, [
        `ci_required=${String(output.ci_required)}`,
        `naming_required=${String(output.naming_required)}`,
        `review_required=${String(output.review_required)}`,
        `review_agent=${asString(output.review_agent)}`,
        `review_model=${asString(output.review_model)}`,
        `review_rule=${asString(output.review_rule)}`,
        `review_llm_timeout=${String(output.review_llm_timeout)}`,
        `review_task_timeout=${String(output.review_task_timeout)}`,
        `review_concurrency=${String(output.review_concurrency)}`,
        `review_resume_attempts=${String(output.review_resume_attempts)}`,
        `review_resume_backoff_seconds=${String(output.review_resume_backoff_seconds)}`,
        `block_severity=${asString(output.block_severity)}`,
        `review_effort=${asString(output.review_effort)}`,
      ]);
      const triage = isJsonRecord(output.triage) ? output.triage : {};
      await appendLines(process.env.GITHUB_STEP_SUMMARY, [
        "### Review Route", "", `- triage: ${asString(triage.status)}`,
        `- action: ${asString(triage.action)}`, `- agent: ${asString(output.review_agent)}`,
        `- model: ${asString(output.review_model) || "none"}`,
      ]);
    }
    console.log(json);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new CliError(`ERROR: required file not found: ${String(error.message)}`, 65);
    }
    throw error;
  }
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
