import { parseAiAgentConfig } from "./ai-agent-config.ts";
import { CliError, appendLines, handleError, isMain } from "./runtime-command.ts";

export function resolveBootstrapModel(
  repository: string,
  owner: string,
  rawConfig: string,
): string {
  if (!owner || !/^[A-Za-z0-9_.-]+$/.test(owner)) {
    throw new CliError("::error::Invalid GitHub repository owner.", 65);
  }
  if (repository !== `${owner}/ai-gateway`) {
    return "auto";
  }

  const config = parseAiAgentConfig(rawConfig);
  if (config.agents.review?.enabled !== true) {
    return "auto";
  }

  const writing = config.agents.writing;
  const model = writing?.enabled ? writing.model?.trim() ?? "" : "";
  if (!model) {
    throw new CliError(
      "::error::AI Gateway bootstrap requires agents.writing.model in AW_AI_AGENT_CONFIG.",
      65,
    );
  }
  return model;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 2) {
    throw new CliError("Usage: resolve-bootstrap-model.ts <repository> <owner>", 64);
  }
  const [repository = "", owner = ""] = args;
  const model = resolveBootstrapModel(
    repository,
    owner,
    process.env.AW_AI_AGENT_CONFIG ?? "",
  );
  await appendLines(process.env.GITHUB_OUTPUT, [`model=${model}`]);
  console.log(`Gateway bootstrap review model: ${model}`);
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
