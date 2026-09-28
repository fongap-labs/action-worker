import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CliError,
  appendLines,
  handleError,
  isMain,
  parseJson,
} from "./runtime-command.ts";

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
): Promise<string> {
  const parts: string[] = [];

  const claude = await readIfExists(join(controlRoot, "CLAUDE.md"));
  if (claude) {
    parts.push("--- Governance Entry (CLAUDE.md) ---", claude.trimEnd());
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
      64,
    );
  }

  const skills = parseJson(skillsRaw, "::error::AGENT_SKILLS_JSON must be valid JSON.", 64);
  if (!Array.isArray(skills) || !skills.every((item) => typeof item === "string")) {
    throw new CliError("::error::AGENT_SKILLS_JSON must be a string array.", 64);
  }

  const prompt = await composeAgentPrompt(controlRoot, skills);
  await writeFile(outputPath, prompt, "utf8");

  await appendLines(process.env.GITHUB_OUTPUT, [
    `prompt_path=${outputPath}`,
    `prompt_bytes=${Buffer.byteLength(prompt, "utf8")}`,
    `skill_count=${skills.length}`,
  ]);

  console.log(`Agent system prompt written to ${outputPath} (${Buffer.byteLength(prompt, "utf8")} bytes, ${skills.length} skills).`);
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
