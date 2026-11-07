import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDeployManifest } from "./deploy-manifest.ts";
import { parseRunnerPolicy, resolveRunnerProfile, type RunnerPolicy } from "./runner-policy.ts";
import { CliError, handleError, isMain } from "./runtime-command.ts";
import { parseReleaseBuildManifest } from "./validate-release-build-request.ts";

const tools = new Set(["npm", "pnpm", "node", "python", "python3", "cargo"]);
export type PreflightCheck = {
  id: string;
  command: string;
  args: string[];
  mode: "quick" | "full";
};
type PreflightConfig = { schema_version: 1; checks: PreflightCheck[] };
export type BusinessResult = { files: string[]; checks: PreflightCheck[] };

export function parseBusinessChecks(value: unknown): PreflightCheck[] {
  if (value === undefined) return [];
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "checks,schema_version" ||
    (value as PreflightConfig).schema_version !== 1 ||
    !Array.isArray((value as PreflightConfig).checks) ||
    (value as PreflightConfig).checks.length > 12
  ) {
    throw new CliError("Business preflight config is invalid.", 65);
  }
  const checks = (value as PreflightConfig).checks;
  const ids = new Set<string>();
  for (const entry of checks) {
    if (
      !entry ||
      Object.keys(entry).sort().join(",") !== "args,command,id,mode" ||
      !/^[a-z][a-z0-9-]{0,63}$/.test(entry.id) ||
      ids.has(entry.id) ||
      !tools.has(entry.command) ||
      (entry.mode !== "quick" && entry.mode !== "full") ||
      !Array.isArray(entry.args) ||
      entry.args.length > 20 ||
      !entry.args.every(
        (arg) => typeof arg === "string" && arg.length > 0 && arg.length <= 256 && !/[\r\n\0]/.test(arg)
      )
    ) {
      throw new CliError("Business preflight check is invalid or duplicated.", 65);
    }
    ids.add(entry.id);
  }
  return checks;
}

async function readOptionalJson(path: string): Promise<unknown | undefined> {
  if (!existsSync(path)) return undefined;
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

async function existsFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

export async function inspectBusinessProject(
  projectRoot: string,
  runnerPolicy: RunnerPolicy
): Promise<BusinessResult> {
  const root = resolve(projectRoot);
  const files: string[] = [];
  const dirs = [".github"];
  const products = join(root, "projects");
  if (existsSync(products)) {
    for (const dirent of await readdir(products, { withFileTypes: true })) {
      if (dirent.isDirectory() && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(dirent.name)) {
        dirs.push(join("projects", dirent.name));
      }
    }
  }
  for (const folder of dirs) {
    for (const name of ["release.manifest.json", "deploy.json"]) {
      const relative = join(folder, name);
      const text = await readOptionalJson(join(root, relative));
      if (text === undefined) continue;
      files.push(relative);
      if (name === "release.manifest.json") {
        const manifest = parseReleaseBuildManifest(text);
        const buildRoot = join(root, manifest.root ?? "");
        for (const build of manifest.builds) {
          const runner = resolveRunnerProfile(runnerPolicy, build.runner_profile);
          if (runner.profile.trust_domain !== "sandbox") {
            throw new CliError(`Release ${relative}/${build.id} must use sandbox runner.`, 65);
          }
          for (const script of [build.script, build.acceptance_script].filter(Boolean)) {
            if (!(await existsFile(join(buildRoot, script!)))) {
              throw new CliError(`Missing release script in ${relative}: ${script}`, 65);
            }
          }
        }
      } else {
        const manifest = parseDeployManifest(text);
        resolveRunnerProfile(runnerPolicy, manifest.runner_profile);
      }
    }
  }
  const rootLayout = files.some((path) => path.startsWith(".github/"));
  const productLayout = files.some((path) => path.startsWith("projects/"));
  if (rootLayout && productLayout) {
    throw new CliError("Repository cannot mix root and projects/ product manifests.", 65);
  }
  const checks = parseBusinessChecks(
    await readOptionalJson(join(root, ".github", "preflight.json"))
  );
  return { files, checks };
}

export function executeBusinessChecks(
  projectRoot: string,
  checks: readonly PreflightCheck[],
  mode: "quick" | "full"
): void {
  for (const check of checks) {
    if (mode === "quick" && check.mode !== "quick") continue;
    const command =
      process.platform === "win32" && ["npm", "pnpm"].includes(check.command)
        ? `${check.command}.cmd`
        : check.command;
    console.log(`[preflight] ${check.id}: ${command} ${check.args.join(" ")}`);
    const result = spawnSync(command, check.args, {
      cwd: projectRoot,
      stdio: "inherit",
      shell: false,
    });
    if (result.error || result.status !== 0) {
      throw new CliError(`Business preflight failed: ${check.id}`, result.status ?? 66);
    }
  }
}

async function main(): Promise<void> {
  const [directory = ".", mode = "quick", runnerPolicyPath] = process.argv.slice(2);
  if (mode !== "quick" && mode !== "full") {
    throw new CliError(
      "Usage: business-preflight.ts [business-repo-directory] [quick|full] [runner-policy-path]",
      64
    );
  }
  const controlDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const policyFile = runnerPolicyPath
    ? isAbsolute(runnerPolicyPath)
      ? runnerPolicyPath
      : resolve(runnerPolicyPath)
    : join(controlDir, "policies", "runner.json");
  const policy = parseRunnerPolicy(JSON.parse(await readFile(policyFile, "utf8")));
  const result = await inspectBusinessProject(directory, policy);
  console.log(`[preflight] Validated ${result.files.length} business manifests`);
  executeBusinessChecks(resolve(directory), result.checks, mode);
  console.log("[preflight] Checks passed; remote validate-merge remains authoritative.");
}

if (isMain(import.meta.url)) main().catch(handleError);
