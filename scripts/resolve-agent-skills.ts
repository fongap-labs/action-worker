import type { Dirent } from 'node:fs';
import { access, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { appendLines, CliError, handleError, isMain } from './runtime-command.ts';

export type SkillFrontmatter = {
  path: string;
  name: string;
  always: boolean;
  domain: string;
  baseline: boolean;
  operations: string[];
};

function parseOperationList(value: string): string[] {
  const arrayMatch = value.match(/^\[(.*)\]$/);
  if (!arrayMatch) return [];
  return arrayMatch[1]!
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export function parseFrontmatter(content: string, path: string): SkillFrontmatter {
  const normalized = content.replace(/\r\n/g, '\n');
  const match = normalized.match(/^---\n([\s\S]*?)\n---/);
  if (!match) {
    throw new CliError(`::error::Skill missing frontmatter: ${path}.`, 65);
  }

  const fields = new Map<string, string>();
  for (const line of match[1]!.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const colonIndex = trimmed.indexOf(':');
    if (colonIndex === -1) continue;
    fields.set(trimmed.slice(0, colonIndex).trim(), trimmed.slice(colonIndex + 1).trim());
  }

  const name = fields.get('name') ?? '';
  const domain = fields.get('domain') ?? '';
  const always = fields.get('always') === 'true';
  const baseline = fields.get('baseline') === 'true';
  const operations = parseOperationList(fields.get('operations') ?? '');

  if (!name) {
    throw new CliError(`::error::Skill frontmatter missing name: ${path}.`, 65);
  }
  if (!always && !domain) {
    throw new CliError(`::error::Skill frontmatter must define always or domain: ${path}.`, 65);
  }

  return { path, name, always, domain, baseline, operations };
}

export async function discoverSkills(root: string): Promise<SkillFrontmatter[]> {
  const skillsDir = join(root, 'skills');
  let entries: Dirent[];
  try {
    entries = await readdir(skillsDir, { withFileTypes: true });
  } catch {
    throw new CliError('::error::skills/ directory not found.', 65);
  }

  const skills: SkillFrontmatter[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillPath = `skills/${entry.name}/SKILL.md`;
    const fullPath = join(root, skillPath);
    try {
      await access(fullPath);
    } catch {
      continue;
    }
    const content = await readFile(fullPath, 'utf8');
    skills.push(parseFrontmatter(content, skillPath));
  }

  if (skills.length === 0) {
    throw new CliError('::error::No skills discovered in skills/.', 65);
  }

  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

export function selectSkills(
  skills: readonly SkillFrontmatter[],
  agentDomain: string,
  operation: string
): string[] {
  const selected = skills.filter((skill) => {
    if (skill.always) return true;
    if (skill.domain !== agentDomain) return false;
    if (skill.baseline) return true;
    return skill.operations.includes(operation);
  });

  const seen = new Set<string>();
  const result: string[] = [];
  for (const skill of selected) {
    if (!seen.has(skill.path)) {
      seen.add(skill.path);
      result.push(skill.path);
    }
  }
  return result;
}

export async function resolveAndVerifySkills(
  root: string,
  agentDomain: string,
  operation: string
): Promise<string[]> {
  const skills = await discoverSkills(root);

  const domains = new Set(skills.filter((s) => !s.always).map((s) => s.domain));
  if (!domains.has(agentDomain)) {
    throw new CliError(
      `::error::Unknown agent domain: "${agentDomain}". Available: ${[...domains].sort().join(', ')}.`,
      65
    );
  }

  const operations = new Set(
    skills
      .filter((s) => s.domain === agentDomain && s.operations.length > 0)
      .flatMap((s) => s.operations)
  );
  if (operations.size > 0 && !operations.has(operation)) {
    throw new CliError(
      `::error::Unknown operation "${operation}" for domain "${agentDomain}". Available: ${[...operations].sort().join(', ')}.`,
      65
    );
  }

  return selectSkills(skills, agentDomain, operation);
}

async function main(): Promise<void> {
  const [agentDomain = '', operation = ''] = process.argv.slice(2);
  if (!agentDomain || !operation) {
    throw new CliError('Usage: resolve-agent-skills.ts <agent-domain> <operation>', 64);
  }
  const root = process.env.GITHUB_WORKSPACE ?? process.cwd();
  const skills = await resolveAndVerifySkills(root, agentDomain, operation);
  const skillsJson = JSON.stringify(skills);
  await appendLines(process.env.GITHUB_OUTPUT, [
    `skills=${skillsJson}`,
    `skill_count=${skills.length}`,
  ]);
  console.log(
    `Resolved ${skills.length} skill(s) for domain="${agentDomain}" operation="${operation}":`
  );
  for (const skill of skills) {
    console.log(`  ${skill}`);
  }
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
