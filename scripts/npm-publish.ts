import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runCommand } from "./runtime-command.ts";

export const npmRegistry = "https://registry.npmjs.org/";

export function npmAuthConfig(): string {
  return [
    "registry=https://registry.npmjs.org/",
    "//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}",
    "",
  ].join("\n");
}

export async function configureNpmAuth(
  workingDirectory: string,
  token: string
): Promise<NodeJS.ProcessEnv> {
  await writeFile(join(workingDirectory, ".npmrc"), npmAuthConfig(), {
    encoding: "utf8",
    mode: 0o600,
  });
  return {
    ...process.env,
    NODE_AUTH_TOKEN: token,
    npm_config_registry: npmRegistry,
  };
}

export function npmPublishArgs(tarballPath: string, version: string): string[] {
  const args = ["publish", tarballPath, "--access", "public"];
  if (version.includes("-beta.")) {
    args.push("--tag", "beta");
  }
  return args;
}

export async function publishNpmTarball(
  tarballPath: string,
  workingDirectory: string,
  token: string,
  version: string
): Promise<void> {
  const env = await configureNpmAuth(workingDirectory, token);
  await runCommand("npm", npmPublishArgs(tarballPath, version), {
    cwd: workingDirectory,
    env,
    timeoutMs: 300_000,
  });
}
