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

export function enabledAiModels(config: AiAgentConfig, agentNames?: readonly string[]): string[] {
  const models = new Set<string>();
  const selected = agentNames ? new Set(agentNames) : null;
  for (const [agentName, agent] of Object.entries(config.agents)) {
    if (selected && !selected.has(agentName)) continue;
    if (!agent.enabled) continue;
    if (agent.model) models.add(agent.model);
    for (const route of Object.values(agent.routes)) {
      models.add(route.model);
    }
  }
  return [...models].sort();
}


function runtimeToken(value: string): string {
  return value.toUpperCase().replaceAll("-", "_");
}

export function aiAgentRuntimeEntries(config: AiAgentConfig): Array<[string, string]> {
  const entries: Array<[string, string]> = [];
  const names = new Set<string>();

  const add = (name: string, model: string): void => {
    if (names.has(name)) {
      throw new CliError(`::error::AI agent runtime variable collision: ${name}`, 65);
    }
    names.add(name);
    entries.push([name, model]);
  };

  for (const [agentName, agent] of Object.entries(config.agents).sort(([a], [b]) => a.localeCompare(b))) {
    if (!agent.enabled) continue;
    const agentToken = runtimeToken(agentName);
    if (agent.model) {
      add(`AW_AI_AGENT_${agentToken}_MODEL`, agent.model);
    }
    for (const [routeName, route] of Object.entries(agent.routes).sort(([a], [b]) => a.localeCompare(b))) {
      add(
        `AW_AI_AGENT_${agentToken}_${runtimeToken(routeName)}_MODEL`,
        route.model,
      );
    }
  }

  return entries;
}
