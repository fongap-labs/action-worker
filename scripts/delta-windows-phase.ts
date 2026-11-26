/** Bound a trusted Windows CI native command without interpreting target-controlled shell text. */
import { spawn, spawnSync } from "node:child_process";

const HEARTBEAT_MS = 60_000;
const MAX_TIMEOUT_SECONDS = 3600;
const invocationVariable = "AW_DELTA_PHASE_INVOCATION";
const wrapper = [
  "$ErrorActionPreference = 'Stop'",
  "$PSNativeCommandUseErrorActionPreference = $false",
  "$invocation = $env:AW_DELTA_PHASE_INVOCATION | ConvertFrom-Json",
  "Remove-Item Env:AW_DELTA_PHASE_INVOCATION",
  "$childArgs = @($invocation.args)",
  "& ([string]$invocation.command) @childArgs",
  "if ($null -eq $LASTEXITCODE) { exit 1 }",
  "exit $LASTEXITCODE",
].join("\n");

export function runBoundedCommand(
  stage: string,
  command: string,
  args: string[],
  timeoutMs: number,
  env: NodeJS.ProcessEnv = process.env
): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env, stdio: "inherit", windowsHide: true, shell: false });
    const started = Date.now();
    let isSettled = false;
    const finish = (code: number) => {
      if (isSettled) return;
      isSettled = true;
      clearTimeout(deadline);
      clearInterval(heartbeat);
      resolve(code);
    };
    const heartbeat = setInterval(() => {
      console.log(
        `Delta Windows CI heartbeat stage=${stage} elapsed_s=${Math.floor((Date.now() - started) / 1000)}`
      );
    }, HEARTBEAT_MS);
    const deadline = setTimeout(() => {
      if (child.pid !== undefined && process.platform === "win32") {
        spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
          timeout: 10_000,
          stdio: "ignore",
          windowsHide: true,
        });
      }
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      child.unref();
      console.error(`Delta Windows CI phase timeout stage=${stage}`);
      finish(124);
    }, timeoutMs);
    child.once("error", () => finish(1));
    child.once("exit", (code) => finish(code ?? 1));
  });
}

async function main(): Promise<number> {
  const [stage, seconds, command, ...args] = process.argv.slice(2);
  const timeout = Number(seconds);
  if (
    process.platform !== "win32" ||
    !stage ||
    !/^[a-z-]+$/.test(stage) ||
    !command ||
    !Number.isInteger(timeout) ||
    timeout < 1 ||
    timeout > MAX_TIMEOUT_SECONDS
  ) {
    return 64;
  }
  const env = { ...process.env, [invocationVariable]: JSON.stringify({ command, args }) };
  return runBoundedCommand(
    stage,
    "pwsh.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(wrapper, "utf16le").toString("base64"),
    ],
    timeout * 1000,
    env
  );
}

if (import.meta.main) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch(() => {
      process.exitCode = 1;
    });
}
