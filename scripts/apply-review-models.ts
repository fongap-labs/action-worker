import { parseAiAgentConfig } from "./ai-agent-config.ts";
import { isJsonRecord } from "./github-api.ts";
import { CliError, handleError, isMain, readJson, runText } from "./runtime-command.ts";

const variableName = "AW_AI_AGENT_CONFIG";
const requiredRoutes = ["code", "workflow", "release", "security", "architecture", "deep"];

type ReviewModelPolicy = {
  schema_version: 1;
  models: string[];
  review: {
    enabled: true;
    model: string;
    routes: Record<string, { model: string }>;
  };
};

export function parseReviewModelPolicy(value: unknown): ReviewModelPolicy {
  if (!isJsonRecord(value) || value.schema_version !== 1 || !Array.isArray(value.models)) {
    throw new CliError("::error::Invalid review model policy.", 65);
  }
  const models = value.models;
  if (
    models.length !== 2 ||
    !models.every((model): model is string => typeof model === "string" && model.length > 0) ||
    new Set(models).size !== models.length
  ) {
    throw new CliError("::error::Review model policy must specify exactly two distinct models.", 65);
  }
  const review = value.review;
  if (
    !isJsonRecord(review) ||
    review.enabled !== true ||
    typeof review.model !== "string" ||
    !models.includes(review.model) ||
    !isJsonRecord(review.routes)
  ) {
    throw new CliError("::error::Review model policy has an invalid review configuration.", 65);
  }
  if (
    Object.keys(review.routes).length !== requiredRoutes.length ||
    !requiredRoutes.every((route) => {
      const config = review.routes[route];
      return isJsonRecord(config) && typeof config.model === "string" && models.includes(config.model);
    })
  ) {
    throw new CliError("::error::Review model policy must route each review agent to an allowed model.", 65);
  }
  return value as unknown as ReviewModelPolicy;
}

export function applyReviewModels(rawConfig: string, policyValue: unknown): string {
  parseAiAgentConfig(rawConfig);
  const config = JSON.parse(rawConfig) as unknown;
  if (!isJsonRecord(config) || !isJsonRecord(config.agents)) {
    throw new CliError("::error::Invalid current AI agent configuration.", 65);
  }
  const policy = parseReviewModelPolicy(policyValue);
  const updated = {
    ...config,
    agents: { ...config.agents, review: policy.review },
  };
  const result = JSON.stringify(updated);
  parseAiAgentConfig(result);
  return result;
}

async function getVariable(repository: string, token: string): Promise<string> {
  const response = await runText(
    "gh",
    ["api", `repos/${repository}/actions/variables/${variableName}`],
    { env: { ...process.env, GH_TOKEN: token }, timeoutMs: 30_000 }
  );
  const value = JSON.parse(response) as unknown;
  if (!isJsonRecord(value) || typeof value.value !== "string") {
    throw new CliError("::error::AI agent variable response is invalid.", 65);
  }
  return value.value;
}

async function main(): Promise<void> {
  const repository = process.argv[2] ?? "";
  const token = process.env.GH_TOKEN ?? "";
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !token) {
    throw new CliError("::error::Review model sync requires a repository and admin token.", 65);
  }
  const policy = await readJson("policies/review-models.json");
  const current = await getVariable(repository, token);
  const next = applyReviewModels(current, policy);
  if (JSON.stringify(JSON.parse(current)) === next) {
    console.log("AI Review models are already aligned with source policy.");
    return;
  }
  await runText(
    "gh",
    ["api", "--method", "PATCH", `repos/${repository}/actions/variables/${variableName}`, "--input", "-"],
    {
      env: { ...process.env, GH_TOKEN: token },
      input: JSON.stringify({ name: variableName, value: next }),
      timeoutMs: 30_000,
    }
  );
  const saved = await getVariable(repository, token);
  if (JSON.stringify(JSON.parse(saved)) !== next) {
    throw new CliError("::error::AI Review model variable did not match source policy.", 65);
  }
  console.log("AI Review model routes updated and verified. Other AI agents remain unchanged.");
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
