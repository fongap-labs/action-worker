import { spawn } from "node:child_process";
import { appendFile, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export class CliError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
  }
}

type CommandOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  maxBuffer?: number;
};

export async function runCommand(
  command: string,
  args: readonly string[],
  options: CommandOptions = {},
): Promise<Buffer> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let size = 0;
    const limit = options.maxBuffer ?? 50 * 1024 * 1024;

    child.stdout!.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        child.kill();
        reject(new CliError(`${command} output exceeded ${limit} bytes.`));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr!.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => reject(error));
    child.on("close", (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout));
        return;
      }
      const detail = Buffer.concat(stderr).toString("utf8").trim();
      reject(new CliError(detail || `${command} exited with status ${code ?? 1}.`, code ?? 1));
    });

    if (options.input !== undefined) {
      child.stdin!.end(options.input);
    }
  });
}

export async function runText(
  command: string,
  args: readonly string[],
  options: CommandOptions = {},
): Promise<string> {
  return (await runCommand(command, args, options)).toString("utf8").trimEnd();
}

export async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

export function parseJson(value: string, message: string, exitCode = 65): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new CliError(message, exitCode);
  }
}

export async function appendLines(path: string | undefined, lines: readonly string[]): Promise<void> {
  if (!path) {
    return;
  }
  await appendFile(path, `${lines.join("\n")}\n`, "utf8");
}

export function isMain(metaUrl: string): boolean {
  const entry = process.argv[1];
  return entry !== undefined && metaUrl === pathToFileURL(entry).href;
}

export function handleError(error: unknown): never {
  if (error instanceof CliError) {
    console.error(error.message);
    process.exit(error.exitCode);
  }
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
}
