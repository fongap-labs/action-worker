import { access, readFile } from "node:fs/promises";
import { parseTestPackConfig } from "./resolve-test-pack.ts";
import { CliError, handleError, isMain, runCommand, runText } from "./runtime-command.ts";

export async function prepareTestPack(workerRoot: string, configPath: string): Promise<string> {
  try {
    await access(configPath);
  } catch {
    return "main";
  }
  const { ref } = parseTestPackConfig(await readFile(configPath, "utf8"));
  if (ref === "main") {
    return ref;
  }
  // A pinned pack must be history of the trusted default branch, never a side branch.
  try {
    await runCommand("git", ["merge-base", "--is-ancestor", ref, "HEAD"], { cwd: workerRoot });
  } catch {
    throw new CliError(
      `Test pack ref ${ref} is not part of the trusted action-worker history.`,
      65
    );
  }
  await runCommand("git", ["checkout", "--quiet", "--detach", ref], { cwd: workerRoot });
  return (await runText("git", ["rev-parse", "HEAD"], { cwd: workerRoot })).trim();
}

async function main(): Promise<void> {
  const [workerRoot = "", configPath = ""] = process.argv.slice(2);
  if (!workerRoot || !configPath) {
    throw new CliError("Usage: prepare-test-pack.ts <action-worker-root> <test-pack.json>", 64);
  }
  console.log(`Test pack source: ${await prepareTestPack(workerRoot, configPath)}`);
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
