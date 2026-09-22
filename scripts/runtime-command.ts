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
  maxStderrBuffer?: number;
  timeoutMs?: number;
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
    let stdoutSize = 0;
    let stderrSize = 0;
    let isSettled = false;
    const stdoutLimit = options.maxBuffer ?? 50 * 1024 * 1024;
    const stderrLimit = options.maxStderrBuffer ?? 10 * 1024 * 1024;
    const finish = (error?: unknown, output?: Buffer): void => {
      if (isSettled) {
        return;
      }
      isSettled = true;
      if (timer) {
        clearTimeout(timer);
      }
      if (error !== undefined) {
        reject(error);
      } else {
        resolve(output ?? Buffer.alloc(0));
      }
    };
    const timer = options.timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
        child.kill();
        finish(new CliError(`${command} timed out after ${options.timeoutMs} ms.`, 124));
      }, options.timeoutMs);

    child.stdout!.on("data", (chunk: Buffer) => {
      stdoutSize += chunk.length;
      if (stdoutSize > stdoutLimit) {
        child.kill();
        finish(new CliError(`${command} stdout exceeded ${stdoutLimit} bytes.`));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      stderrSize += chunk.length;
      if (stderrSize > stderrLimit) {
        child.kill();
        finish(new CliError(`${command} stderr exceeded ${stderrLimit} bytes.`));
        return;
      }
      stderr.push(chunk);
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (isSettled) {
        return;
      }
      if (code === 0) {
        finish(undefined, Buffer.concat(stdout));
        return;
      }
      const detail = Buffer.concat(stderr).toString("utf8").trim();
      finish(new CliError(detail || `${command} exited with status ${code ?? 1}.`, code ?? 1));
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
