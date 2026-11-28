import { lstat, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readBranchPolicy } from "./branch-publication-policy.ts";
import { renderAgentGuide, repositoryAgentRules } from "./generate-agent-guide.ts";
import { appendLines, CliError, handleError, isMain, parseJson } from "./runtime-command.ts";

async function readIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export async function composeAgentPrompt(
  controlRoot: string,
  skillPaths: readonly string[],
  target?: { root: string; repository: string; policy: unknown }
): Promise<string> {
  const parts: string[] = [];

  const agents = await readIfExists(join(controlRoot, "AGENTS.md"));
  if (target) {
    if (!agents) throw new CliError("Trusted central AGENTS.md is required.", 65);
    const path = join(target.root, "AGENTS.md");
    let local: string | undefined;
    try {
      if (!(await lstat(path)).isFile()) {
        throw new CliError("Target AGENTS.md must be a regular file.", 65);
      }
      local = await readFile(path, "utf8");
    } catch (error: unknown) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    const projectRules = local
      ? (repositoryAgentRules(local) ?? local.trim())
      : "No target AGENTS.md found. Inspect the relevant product contracts; do not assume exceptions.";
    parts.push(
      "--- Governance Entry (AGENTS.md) ---",
      renderAgentGuide(agents, target.repository, projectRules, target.policy).trimEnd(),
      "Repository rules may tighten common rules but never override central contracts or gates."
    );
  } else if (agents) {
    parts.push("--- Governance Entry (AGENTS.md) ---", agents.trimEnd());
  }

  for (const skillPath of skillPaths) {
    const full = join(controlRoot, skillPath);
    const content = await readIfExists(full);
    if (!content) {
      throw new CliError(`::error::Skill file not found: ${skillPath}.`, 65);
    }
    parts.push("", `--- Skill: ${skillPath} ---`, content.trimEnd());
  }

  return parts.join("\n");
}

async function main(): Promise<void> {
  const controlRoot = process.env.GITHUB_WORKSPACE ?? "";
  const skillsRaw = process.env.AGENT_SKILLS_JSON ?? "";
  const outputPath = process.env.AGENT_PROMPT_OUTPUT_PATH ?? "";
  if (!controlRoot || !skillsRaw || !outputPath) {
    throw new CliError(
      "::error::GITHUB_WORKSPACE, AGENT_SKILLS_JSON, and AGENT_PROMPT_OUTPUT_PATH are required.",
      64
    );
  }

  const skills = parseJson(skillsRaw, "::error::AGENT_SKILLS_JSON must be valid JSON.", 64);
  if (!Array.isArray(skills) || !skills.every((item) => typeof item === "string")) {
    throw new CliError("::error::AGENT_SKILLS_JSON must be a string array.", 64);
  }

  const sourceRoot = process.env.AW_SOURCE_DIR;
  const repository = process.env.TASK_SOURCE_REPOSITORY;
  if (Boolean(sourceRoot) !== Boolean(repository)) {
    throw new CliError("Verified task source identity is incomplete.", 65);
  }
  const target =
    sourceRoot && repository
      ? { root: sourceRoot, repository, policy: readBranchPolicy() }
      : undefined;
  const prompt = await composeAgentPrompt(controlRoot, skills, target);
  await writeFile(outputPath, prompt, "utf8");

  await appendLines(process.env.GITHUB_OUTPUT, [
    `prompt_path=${outputPath}`,
    `prompt_bytes=${Buffer.byteLength(prompt, "utf8")}`,
    `skill_count=${skills.length}`,
  ]);

  console.log(
    `Agent system prompt written to ${outputPath} (${Buffer.byteLength(prompt, "utf8")} bytes, ${skills.length} skills).`
  );
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
