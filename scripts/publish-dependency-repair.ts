import { copyFile, mkdir, readdir, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { GithubReader } from "./github-api.ts";
import {
  decodeGithubContent,
  parseDependencyRepairManifest,
  resolveDependencyRepairFacts,
  selectDependencyRepair,
  type DependencyRepairRequest,
} from "./dependency-repair.ts";
import {
  CliError,
  handleError,
  isMain,
  parseJson,
  runText,
} from "./runtime-command.ts";

function safeRelativePath(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 512
    && !value.startsWith("/")
    && !/^[A-Za-z]:[\\/]/.test(value)
    && !value.split(/[\\/]+/).includes("..")
    && /^[A-Za-z0-9._/-]+$/.test(value);
}

function confined(root: string, path: string): string {
  const base = resolve(root);
  const target = resolve(base, path);
  if (target !== base && !target.startsWith(base + sep)) {
    throw new CliError(`Dependency repair publish path escapes root: ${path}.`, 77);
  }
  return target;
}

async function filesUnder(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const parent = entry.parentPath ?? root;
      return relative(root, join(parent, entry.name)).replaceAll("\\", "/");
    })
    .sort();
}

async function main(): Promise<void> {
  const [
    repository = "",
    prRaw = "",
    headSha = "",
    headRef = "",
    baseSha = "",
    repairId = "",
    rawOutputPaths = "",
    stagingRoot = "",
    targetRoot = "",
  ] = process.argv.slice(2);
  const token = process.env.AW_CONTROL_TOKEN ?? "";
  const prNumber = Number(prRaw);
  const outputPaths = parseJson(
    rawOutputPaths,
    "Dependency repair output paths must be valid JSON.",
    64,
  );
  if (!token
    || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)
    || !Number.isInteger(prNumber) || prNumber < 1
    || !/^[0-9a-f]{40}$/.test(headSha)
    || !/^[A-Za-z0-9._/-]+$/.test(headRef)
    || !/^[0-9a-f]{40}$/.test(baseSha)
    || !/^[a-z][a-z0-9-]{0,63}$/.test(repairId)
    || !Array.isArray(outputPaths)
    || !outputPaths.every(safeRelativePath)
    || !stagingRoot
    || !targetRoot
  ) {
    throw new CliError("Dependency repair publish arguments are invalid.", 64);
  }

  const request: DependencyRepairRequest = {
    schema_version: "1",
    request_id: `publish:${repository.replace("/", "-")}:${prNumber}:${headSha.slice(0, 12)}`,
    repository,
    pr_number: prNumber,
    head_sha: headSha,
  };
  const reader = new GithubReader(process.env.GITHUB_API_URL ?? "https://api.github.com", token);
  const facts = await resolveDependencyRepairFacts(reader, request);
  if (facts.base_sha !== baseSha || facts.head_ref !== headRef) {
    throw new CliError("Dependency repair PR moved before publication.", 75);
  }

  const manifestResponse = await reader.get(
    `repos/${repository}/contents/.github/dependency-repair.json?ref=${baseSha}`,
  );
  const manifest = parseDependencyRepairManifest(
    parseJson(
      decodeGithubContent(manifestResponse),
      "Dependency repair manifest must be valid JSON.",
      65,
    ),
  );
  const repair = selectDependencyRepair(manifest, facts);
  if (!repair
    || repair.id !== repairId
    || JSON.stringify([...repair.output_paths].sort()) !== JSON.stringify([...(outputPaths as string[])].sort())
  ) {
    throw new CliError("Dependency repair grant changed before publication.", 77);
  }

  const staged = await filesUnder(stagingRoot);
  if (staged.length < 1
    || staged.some((path) => !(outputPaths as string[]).includes(path))
  ) {
    throw new CliError("Dependency repair artifact contains unauthorized paths.", 77);
  }

  const checkedOutSha = await runText("git", ["rev-parse", "HEAD"], { cwd: targetRoot });
  if (checkedOutSha !== headSha) {
    throw new CliError("Dependency repair checkout no longer matches the approved PR head.", 75);
  }

  for (const path of staged) {
    const source = confined(stagingRoot, path);
    const details = await stat(source);
    if (!details.isFile() || details.size > 50 * 1024 * 1024) {
      throw new CliError(`Dependency repair artifact is invalid: ${path}.`, 66);
    }
    const destination = confined(targetRoot, path);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination);
  }

  await runText("git", ["add", "--", ...staged], { cwd: targetRoot });
  const stagedDiff = (await runText("git", ["diff", "--cached", "--name-only", "--no-renames"], { cwd: targetRoot }))
    .split(/\r?\n/)
    .filter(Boolean)
    .sort();
  if (stagedDiff.length < 1
    || stagedDiff.some((path) => !(outputPaths as string[]).includes(path))
  ) {
    throw new CliError("Dependency repair staged unauthorized paths.", 77);
  }

  await runText("git", ["config", "user.name", "github-actions[bot]"], { cwd: targetRoot });
  await runText(
    "git",
    ["config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"],
    { cwd: targetRoot },
  );
  await runText(
    "git",
    ["commit", "-m", `chore(deps): refresh generated dependency files [${repairId}]`],
    { cwd: targetRoot },
  );
  await runText(
    "git",
    ["push", "origin", `HEAD:refs/heads/${headRef}`],
    { cwd: targetRoot, timeoutMs: 60_000 },
  );

  console.log(JSON.stringify({
    repository,
    pr_number: prNumber,
    previous_head_sha: headSha,
    head_ref: headRef,
    repair_id: repairId,
    outputs: stagedDiff,
  }));
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
