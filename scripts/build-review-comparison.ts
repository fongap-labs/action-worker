import { lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CliError,
  handleError,
  isMain,
  runText,
} from "./runtime-command.ts";

async function gitText(root: string, args: readonly string[], indexPath?: string, input?: string): Promise<string> {
  const env = indexPath ? { ...process.env, GIT_INDEX_FILE: indexPath } : process.env;
  return await runText("git", args, { cwd: root, env, input });
}

export async function buildComparison(root: string, base: string, head: string, evidencePath: string): Promise<{ base_sha: string; head_sha: string }> {
  if (evidencePath !== ".action-worker-ci-evidence.json") {
    throw new CliError(`ERROR: unexpected CI evidence path: ${evidencePath}`, 65);
  }
  if (!/^[0-9a-f]{40}$/.test(base) || !/^[0-9a-f]{40}$/.test(head)) {
    throw new CliError("ERROR: invalid review commit SHA.", 65);
  }
  if (await gitText(root, ["rev-parse", "--is-inside-work-tree"]) !== "true") {
    throw new CliError("ERROR: review repository is not a Git worktree.", 65);
  }
  const evidence = await lstat(join(root, evidencePath));
  if (!evidence.isFile() || evidence.isSymbolicLink()) {
    throw new CliError("ERROR: controlled CI evidence file is missing or unsafe.", 65);
  }
  await gitText(root, ["cat-file", "-e", `${base}^{commit}`]);
  await gitText(root, ["cat-file", "-e", `${head}^{commit}`]);
  const tempDir = await mkdtemp(join(tmpdir(), "action-worker-review-"));
  const baseIndex = join(tempDir, "base.index");
  const headIndex = join(tempDir, "head.index");
  try {
    await gitText(root, ["read-tree", base], baseIndex);
    await gitText(root, ["add", "--force", "--", evidencePath], baseIndex);
    const baseTree = await gitText(root, ["write-tree"], baseIndex);
    const reviewBase = await gitText(root, [
      "-c", "user.name=Action Worker",
      "-c", "user.email=action-worker@users.noreply.github.com",
      "commit-tree", baseTree, "-p", base,
    ], undefined, "Inject Action Worker CI evidence at review base\n");
    await gitText(root, ["read-tree", head], headIndex);
    await gitText(root, ["add", "--force", "--", evidencePath], headIndex);
    const headTree = await gitText(root, ["write-tree"], headIndex);
    const reviewHead = await gitText(root, [
      "-c", "user.name=Action Worker",
      "-c", "user.email=action-worker@users.noreply.github.com",
      "commit-tree", headTree, "-p", head, "-p", reviewBase,
    ], undefined, "Inject Action Worker CI evidence at review head\n");
    if (!/^[0-9a-f]{40}$/.test(reviewBase) || !/^[0-9a-f]{40}$/.test(reviewHead)) {
      throw new CliError("ERROR: failed to create review comparison commits.");
    }
    return { base_sha: reviewBase, head_sha: reviewHead };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 4) {
    throw new CliError("Usage: build-review-comparison.ts <repository-path> <base-sha> <head-sha> <evidence-path>", 64);
  }
  const [root = "", base = "", head = "", evidence = ""] = args;
  console.log(JSON.stringify(await buildComparison(root, base, head, evidence)));
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
