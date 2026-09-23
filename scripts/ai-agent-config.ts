import { CliError, parseJson } from "./runtime-command.ts";

export type AiAgentRouteConfig = {
  model: string;
};

export type AiAgentConfigEntry = {
  enabled: boolean;
  model?: string;
  routes: Record<string, AiAgentRouteConfig>;
};

export type AiAgentConfig = {
  schema_version: 1;
  agents: Record<string, AiAgentConfigEntry>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateName(value: string, label: string): string {
  const name = value.trim();
  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    throw new CliError(`::error::${label} must use lower-kebab-case.`, 65);
  }
  return name;
}

export function parseAiAgentConfig(raw: string): AiAgentConfig {
  if (!raw.trim()) {
    return { schema_version: 1, agents: {} };
  }
  const value = parseJson(raw, "::error::AW_AI_AGENT_CONFIG must be valid JSON.");
  if (!isRecord(value) || value.schema_version !== 1 || !isRecord(value.agents)) {
    throw new CliError("::error::AW_AI_AGENT_CONFIG must contain schema_version=1 and agents.", 65);
  }

  const agents: Record<string, AiAgentConfigEntry> = {};
  for (const [rawAgentName, rawAgentValue] of Object.entries(value.agents)) {
    const agentName = validateName(rawAgentName, "AI agent name");
    if (!isRecord(rawAgentValue) || typeof rawAgentValue.enabled !== "boolean") {
      throw new CliError(`::error::AW_AI_AGENT_CONFIG agent "${agentName}" must define enabled as a boolean.`, 65);
    }

    const model = typeof rawAgentValue.model === "string" ? rawAgentValue.model.trim() : "";
    if (rawAgentValue.model !== undefined && !model) {
      throw new CliError(`::error::AW_AI_AGENT_CONFIG agent "${agentName}" has an invalid model.`, 65);
    }

    const routes: Record<string, AiAgentRouteConfig> = {};
    if (rawAgentValue.routes !== undefined) {
      if (!isRecord(rawAgentValue.routes)) {
        throw new CliError(`::error::AW_AI_AGENT_CONFIG agent "${agentName}" routes must be an object.`, 65);
      }
      for (const [rawRouteName, rawRouteValue] of Object.entries(rawAgentValue.routes)) {
        const routeName = validateName(rawRouteName, `AI agent route for ${agentName}`);
        if (!isRecord(rawRouteValue) || typeof rawRouteValue.model !== "string" || !rawRouteValue.model.trim()) {
          throw new CliError(
            `::error::AW_AI_AGENT_CONFIG route "${agentName}.${routeName}" must define a non-empty model.`,
            65,
          );
        }
        routes[routeName] = { model: rawRouteValue.model.trim() };
      }
    }

    if (rawAgentValue.enabled && !model && Object.keys(routes).length === 0) {
      throw new CliError(
        `::error::AW_AI_AGENT_CONFIG enabled agent "${agentName}" must define model or routes.`,
        65,
      );
    }

    agents[agentName] = {
      enabled: rawAgentValue.enabled,
      ...(model ? { model } : {}),
      routes,
    };
  }

  return { schema_version: 1, agents };
}

export function isAiAgentEnabled(config: AiAgentConfig, agentName: string): boolean {
  return config.agents[agentName]?.enabled === true;
}

export function aiAgentModel(config: AiAgentConfig, agentName: string, routeName?: string): string {
  const agent = config.agents[agentName];
  if (!agent?.enabled) {
    throw new CliError(`::error::AI agent "${agentName}" is disabled.`, 65);
  }
  const routed = routeName ? agent.routes[routeName]?.model ?? "" : "";
  const model = routed || agent.model || "";
  if (!model) {
    const suffix = routeName ? ` route "${routeName}"` : "";
    throw new CliError(`::error::AI agent "${agentName}"${suffix} has no configured model.`, 65);
  }
  return model;
}

export function enabledAiModels(config: AiAgentConfig): string[] {
  const models = new Set<string>();
  for (const agent of Object.values(config.agents)) {
    if (!agent.enabled) continue;
    if (agent.model) models.add(agent.model);
    for (const route of Object.values(agent.routes)) {
      models.add(route.model);
    }
  }
  return [...models].sort();
}
