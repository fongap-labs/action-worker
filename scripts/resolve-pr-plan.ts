import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CliError,
  appendLines,
  handleError,
  isMain,
  parseJson,
  readJson,
} from "./runtime-command.ts";
import {
  aiAgentModel,
  isAiAgentEnabled,
  parseAiAgentConfig,
  type AiAgentConfig,
} from "./ai-agent-config.ts";

type Risk = "low" | "medium" | "high";
type ReviewAgent = "none" | "code" | "workflow" | "security" | "architecture" | "release";

export type PrContext = {
  project_types: string[];
  change_areas: string[];
  declared_impacts: string[];
  risk: Risk;
  [key: string]: unknown;
};

type ChecksPolicy = {
  always: string[];
  by_change_area: Record<string, string[] | undefined>;
  by_impact: Record<string, string[] | undefined>;
};

type TestsPolicy = {
  trigger_change_areas: string[];
  full_impacts: string[];
  by_project_type: Record<string, string[] | undefined>;
  impact_tests: Record<string, string[] | undefined>;
};

type ReviewPolicy = {
  agents: Record<string, { effort?: string; rule?: string; task_timeout_minutes?: number } | undefined>;
  runtime: {
    llm_timeout_seconds?: number;
    task_timeout_minutes?: number;
    concurrency?: number;
    resume_attempts?: number;
    resume_backoff_seconds?: number;
  };
};

type TriagePolicy = {
  enabled_agents: string[];
  timeout_seconds?: number;
};

type ExecutionPolicy = {
  ci: {
    required_change_areas: string[];
    required_impacts: string[];
  };
};

type NamingPolicy = {
  always: boolean;
};

export type PlanOptions = {
  namingMode: string;
  reviewMode: string;
  blockOverride: string;
  effortOverride: string;
  modelOverride: string;
  agentOverride: string;
};

export type PlanPolicies = {
  naming: NamingPolicy;
  checks: ChecksPolicy;
  tests: TestsPolicy;
  review: ReviewPolicy;
  triage: TriagePolicy;
  execution: ExecutionPolicy;
  aiAgents: AiAgentConfig;
};

export type PrPlan = {
  context: PrContext;
  checks: string[];
  tests: string[];
  ci_required: boolean;
  naming_required: boolean;
  review_required: boolean;
  review_agent: ReviewAgent;
  review_model: string;
  review_rule: string;
  review_llm_timeout: number;
  review_task_timeout: number;
  review_concurrency: number;
  review_resume_attempts: number;
  review_resume_backoff_seconds: number;
  triage_required: boolean;
  triage_model: string;
  triage_timeout: number;
  block_severity: string;
  review_effort: string;
  route_severity: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateContext(value: unknown): PrContext {
  if (
    !isRecord(value)
    || !Array.isArray(value.project_types)
    || !Array.isArray(value.change_areas)
    || !Array.isArray(value.declared_impacts)
    || !["low", "medium", "high"].includes(String(value.risk))
  ) {
    throw new CliError("::error::Invalid PR context format.", 65);
  }
  return value as PrContext;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right, "en"));
}

function hasItem(values: readonly string[], expected: string): boolean {
  return values.includes(expected);
}

function requireRange(value: number, minimum: number, maximum: number, message: string): void {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new CliError(message, 65);
  }
}

function selectAgent(context: PrContext): ReviewAgent {
  if (hasItem(context.change_areas, "security") || hasItem(context.declared_impacts, "security")) {
    return "security";
  }
  if (["breaking", "migration", "api", "deployment", "compatibility"].some(
    (impact) => hasItem(context.declared_impacts, impact),
  )) {
    return "architecture";
  }
  if (hasItem(context.change_areas, "workflow")) {
    return "workflow";
  }
  if (hasItem(context.change_areas, "release") || hasItem(context.declared_impacts, "release")) {
    return "release";
  }
  if (["source", "script", "container"].some((area) => hasItem(context.change_areas, area))) {
    return "code";
  }
  return "none";
}

export function resolvePlan(
  context: PrContext,
  policies: PlanPolicies,
  options: PlanOptions,
): PrPlan {
  const checks = uniqueSorted([
    ...policies.checks.always,
    ...context.change_areas.flatMap((area) => policies.checks.by_change_area[area] ?? []),
    ...context.declared_impacts.flatMap((impact) => policies.checks.by_impact[impact] ?? []),
  ]);
  const shouldRunTests = context.change_areas.some((area) => policies.tests.trigger_change_areas.includes(area))
    || context.declared_impacts.some((impact) => policies.tests.full_impacts.includes(impact));
  const projectTests = shouldRunTests
    ? context.project_types.flatMap((project) => policies.tests.by_project_type[project] ?? [])
    : [];
  const impactTests = context.declared_impacts.flatMap(
    (impact) => policies.tests.impact_tests[impact] ?? [],
  );
  const tests = uniqueSorted([...projectTests, ...impactTests]);
  const isCiRequired = context.change_areas.some(
    (area) => policies.execution.ci.required_change_areas.includes(area),
  ) || context.declared_impacts.some(
    (impact) => policies.execution.ci.required_impacts.includes(impact),
  );

  let reviewAgent = selectAgent(context);
  const allowedAgents = ["none", "code", "workflow", "security", "architecture", "release"];
  if (options.agentOverride !== "auto") {
    if (!allowedAgents.includes(options.agentOverride)) {
      throw new CliError("::error::review_agent only supports auto/none/code/workflow/security/architecture/release.", 64);
    }
    reviewAgent = options.agentOverride as ReviewAgent;
  }

  const hasTrustedModelOverride = options.modelOverride !== "auto";
  let isReviewRequired = reviewAgent !== "none";
  if (options.reviewMode === "off") {
    isReviewRequired = false;
    reviewAgent = "none";
  } else if (options.reviewMode !== "inherit" && options.reviewMode !== "on") {
    throw new CliError("::error::review_mode only supports inherit/on/off.", 64);
  } else if (!isAiAgentEnabled(policies.aiAgents, "review")) {
    isReviewRequired = false;
    reviewAgent = "none";
  } else if (options.reviewMode === "on") {
    isReviewRequired = true;
    if (reviewAgent === "none") {
      reviewAgent = "code";
    }
  }

  let blockSeverity: string;
  let routeSeverity: string;
  if (context.risk === "high") {
    blockSeverity = "high";
    routeSeverity = "low";
  } else if (context.risk === "medium") {
    blockSeverity = "critical";
    routeSeverity = "low";
  } else {
    blockSeverity = "none";
    routeSeverity = "medium";
  }

  let reviewModel = "";
  let reviewEffort = "low";
  let reviewRule = "";
  let reviewLlmTimeout = 0;
  let reviewTaskTimeout = 0;
  let reviewConcurrency = 0;
  let reviewResumeAttempts = 0;
  let reviewResumeBackoffSeconds = 0;
  let isTriageRequired = false;
  let triageModel = "";
  let triageTimeout = 0;

  if (reviewAgent !== "none") {
    const agent = policies.review.agents[reviewAgent];
    reviewModel = hasTrustedModelOverride
      ? options.modelOverride
      : aiAgentModel(policies.aiAgents, "review", reviewAgent);
    reviewEffort = agent?.effort ?? "medium";
    reviewRule = agent?.rule ?? "";
    reviewLlmTimeout = policies.review.runtime.llm_timeout_seconds ?? 300;
    reviewTaskTimeout = agent?.task_timeout_minutes ?? policies.review.runtime.task_timeout_minutes ?? 2;
    reviewConcurrency = policies.review.runtime.concurrency ?? 1;
    reviewResumeAttempts = policies.review.runtime.resume_attempts ?? 1;
    reviewResumeBackoffSeconds = policies.review.runtime.resume_backoff_seconds ?? 15;

    if (isAiAgentEnabled(policies.aiAgents, "review")
        && isAiAgentEnabled(policies.aiAgents, "triage")
        && policies.triage.enabled_agents.includes(reviewAgent)) {
      isTriageRequired = true;
      triageModel = aiAgentModel(policies.aiAgents, "triage");
      triageTimeout = policies.triage.timeout_seconds ?? 60;
    }
  }

  let isNamingRequired = policies.naming.always;
  if (options.namingMode === "on") {
    isNamingRequired = true;
  } else if (options.namingMode === "off") {
    isNamingRequired = false;
  } else if (options.namingMode !== "inherit") {
    throw new CliError("::error::naming_mode only supports inherit/on/off.", 64);
  }

  if (options.blockOverride !== "inherit") {
    if (!["none", "critical", "high", "medium", "low"].includes(options.blockOverride)) {
      throw new CliError("::error::Invalid block_severity.", 64);
    }
    blockSeverity = options.blockOverride;
  }

  if (options.effortOverride !== "inherit") {
    if (!["low", "medium", "high"].includes(options.effortOverride)) {
      throw new CliError("::error::review_effort only supports inherit/low/medium/high.", 64);
    }
    reviewEffort = options.effortOverride;
  }

  if (options.modelOverride !== "auto") {
    reviewModel = options.modelOverride;
  }

  if (!isReviewRequired) {
    reviewAgent = "none";
    reviewModel = "";
    reviewRule = "";
    reviewLlmTimeout = 0;
    reviewTaskTimeout = 0;
    reviewConcurrency = 0;
    reviewResumeAttempts = 0;
    reviewResumeBackoffSeconds = 0;
    isTriageRequired = false;
    triageModel = "";
    triageTimeout = 0;
    blockSeverity = "none";
  } else {
    requireRange(reviewLlmTimeout, 1, 600, "::error::review_llm_timeout must be 1-600 seconds.");
    requireRange(reviewTaskTimeout, 1, 30, "::error::review_task_timeout must be 1-30 minutes.");
    requireRange(reviewConcurrency, 1, 8, "::error::review_concurrency must be 1-8.");
    requireRange(reviewResumeAttempts, 0, 5, "::error::review_resume_attempts must be 0-5.");
    requireRange(reviewResumeBackoffSeconds, 1, 120, "::error::review_resume_backoff_seconds must be 1-120 seconds.");
    if (!reviewModel) {
      throw new CliError("::error::Invalid review_model configuration.", 65);
    }
  }

  if (isTriageRequired) {
    if (!triageModel) {
      throw new CliError("::error::triage_model is invalid.", 65);
    }
    requireRange(triageTimeout, 1, 300, "::error::triage_timeout must be 1-300 seconds.");
  }

  return {
    context,
    checks,
    tests,
    ci_required: isCiRequired,
    naming_required: isNamingRequired,
    review_required: isReviewRequired,
    review_agent: reviewAgent,
    review_model: reviewModel,
    review_rule: reviewRule,
    review_llm_timeout: reviewLlmTimeout,
    review_task_timeout: reviewTaskTimeout,
    review_concurrency: reviewConcurrency,
    review_resume_attempts: reviewResumeAttempts,
    review_resume_backoff_seconds: reviewResumeBackoffSeconds,
    triage_required: isTriageRequired,
    triage_model: triageModel,
    triage_timeout: triageTimeout,
    block_severity: blockSeverity,
    review_effort: reviewEffort,
    route_severity: routeSeverity,
  };
}

function expectRecord<T>(value: unknown, label: string): T {
  if (!isRecord(value)) {
    throw new CliError(`::error::Invalid ${label} policy.`, 65);
  }
  return value as T;
}

async function loadPolicies(policyDir: string): Promise<PlanPolicies> {
  const paths = {
    naming: join(policyDir, "naming.json"),
    checks: join(policyDir, "checks.json"),
    tests: join(policyDir, "tests.json"),
    review: join(policyDir, "review.json"),
    triage: join(policyDir, "triage.json"),
    execution: join(policyDir, "execution.json"),
  };
  for (const path of Object.values(paths)) {
    try {
      await access(path);
    } catch {
      throw new CliError(`::error::Missing PR policy: ${path}.`, 65);
    }
  }

  const [naming, checks, tests, review, triage, execution] = await Promise.all([
    readJson(paths.naming),
    readJson(paths.checks),
    readJson(paths.tests),
    readJson(paths.review),
    readJson(paths.triage),
    readJson(paths.execution),
  ]);
  return {
    naming: expectRecord<NamingPolicy>(naming, "naming"),
    checks: expectRecord<ChecksPolicy>(checks, "checks"),
    tests: expectRecord<TestsPolicy>(tests, "tests"),
    review: expectRecord<ReviewPolicy>(review, "review"),
    triage: expectRecord<TriagePolicy>(triage, "triage"),
    execution: expectRecord<ExecutionPolicy>(execution, "execution"),
    aiAgents: parseAiAgentConfig(process.env.AW_AI_AGENT_CONFIG ?? ""),
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 8) {
    throw new CliError(
      "Usage: resolve-pr-plan.ts <context-json> <naming-mode> <review-mode> <block-severity> <review-effort> <review-model> <review-agent> <policy-dir>",
      64,
    );
  }
  const [
    contextJson,
    namingMode,
    reviewMode,
    blockOverride,
    effortOverride,
    modelOverride,
    agentOverride,
    policyDir,
  ] = args as [string, string, string, string, string, string, string, string];
  const context = validateContext(parseJson(contextJson, "::error::Invalid PR context format."));
  const policies = await loadPolicies(policyDir);
  const plan = resolvePlan(context, policies, {
    namingMode,
    reviewMode,
    blockOverride,
    effortOverride,
    modelOverride,
    agentOverride,
  });
  const output = JSON.stringify(plan);
  if (process.env.GITHUB_OUTPUT) {
    await writeFile("/tmp/pr-plan.base.json", `${output}\n`, "utf8");
    await appendLines(process.env.GITHUB_OUTPUT, [
      `ci_required=${plan.ci_required}`,
      `naming_required=${plan.naming_required}`,
      `review_required=${plan.review_required}`,
      `triage_required=${plan.triage_required}`,
      `triage_model=${plan.triage_model}`,
      `triage_timeout=${plan.triage_timeout}`,
    ]);
  }
  console.log(output);
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
