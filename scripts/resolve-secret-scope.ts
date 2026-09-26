import { readFile } from "node:fs/promises";
import {
  CliError,
  handleError,
  isMain,
} from "./runtime-command.ts";

const envNamePattern = /^[A-Z][A-Z0-9_]*$/;

function isReserved(name: string): boolean {
  return /^(?:AW_|GITHUB_|RUNNER_|ACTIONS_)/.test(name)
    || name === "NODE_OPTIONS"
    || name === "GH_TOKEN"
    || name === "AIG_ACCESS_KEY_AGENT";
}

async function readNames(path: string): Promise<Set<string>> {
  if (!path) return new Set();
  let text = "";
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return new Set();
    }
    throw error;
  }
  const names = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    if (!line) continue;
    if (!envNamePattern.test(line) || isReserved(line)) {
      throw new CliError(`Secret scope name is invalid or reserved: ${line}.`, 65);
    }
    names.add(line);
  }
  return names;
}

export async function resolveSecretScope(
  baselinePath: string,
  requiredPath: string,
  allowedPath: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<{ allowed: string[]; required: string[]; unset: string[] }> {
  const baselineText = await readFile(baselinePath, "utf8");
  const baseline = new Set(
    baselineText.split(/\r?\n/).map((item) => item.trim()).filter(Boolean),
  );
  const required = await readNames(requiredPath);
  const optional = await readNames(allowedPath);
  const allowed = new Set([...required, ...optional]);

  for (const name of required) {
    if (!environment[name]) {
      throw new CliError(`Required task secret is unavailable: ${name}.`, 77);
    }
  }

  const injected = Object.keys(environment)
    .filter((name) => !baseline.has(name))
    .sort();
  const unset = injected
    .filter((name) => isReserved(name) || !allowed.has(name));

  return {
    allowed: [...allowed].sort(),
    required: [...required].sort(),
    unset,
  };
}

async function main(): Promise<void> {
  const [baselinePath = "", requiredPath = "", allowedPath = ""] = process.argv.slice(2);
  if (!baselinePath) {
    throw new CliError(
      "Usage: resolve-secret-scope.ts <baseline> [required-file] [allowed-file]",
      64,
    );
  }
  console.log(JSON.stringify(
    await resolveSecretScope(baselinePath, requiredPath, allowedPath),
  ));
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
