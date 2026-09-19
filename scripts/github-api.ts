import {
  CliError,
  runCommand,
  runText,
} from "./runtime-command.ts";

export type JsonRecord = Record<string, unknown>;

export function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function getJsonString(value: unknown, key: string): string {
  return isJsonRecord(value) && typeof value[key] === "string" ? value[key] : "";
}

export function getJsonNumber(value: unknown, key: string): number {
  return isJsonRecord(value) && typeof value[key] === "number" ? value[key] : 0;
}

export function getJsonArray(value: unknown, key?: string, exitCode = 65): unknown[] {
  const selected = key && isJsonRecord(value) ? value[key] : value;
  if (!Array.isArray(selected)) {
    throw new CliError("GitHub API returned an invalid response.", exitCode);
  }
  return selected;
}

export function githubEnvironment(token: string): NodeJS.ProcessEnv {
  return { ...process.env, GH_TOKEN: token };
}

export async function runGithubCli(args: readonly string[], token: string): Promise<string> {
  return await runText("gh", args, { env: githubEnvironment(token) });
}

export async function getGithubJson(path: string, token: string): Promise<unknown> {
  return JSON.parse(await runGithubCli(["api", path], token)) as unknown;
}

export async function githubExists(path: string, token: string): Promise<boolean> {
  try {
    await runCommand("gh", ["api", path], { env: githubEnvironment(token) });
    return true;
  } catch {
    return false;
  }
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export class GithubReader {
  readonly apiUrl: string;
  readonly token: string;

  constructor(apiUrl: string, token: string) {
    this.apiUrl = apiUrl.replace(/\/+$/, "");
    this.token = token;
  }

  async get(path: string): Promise<unknown> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= 3; attempt += 1) {
      try {
        const headers: Record<string, string> = {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        };
        if (this.token) {
          headers.Authorization = `Bearer ${this.token}`;
        }
        const response = await fetch(`${this.apiUrl}/${path.replace(/^\/+/, "")}`, { headers });
        if (!response.ok) {
          throw new Error(`GitHub API returned HTTP ${response.status}.`);
        }
        return await response.json() as unknown;
      } catch (error) {
        lastError = error;
        if (attempt < 3) {
          await sleep(2000);
        }
      }
    }
    throw lastError;
  }
}
