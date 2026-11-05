import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { deploySecretDirectory, deploySecretPlanPath } from "./resolve-deploy-secret-plan.ts";
import type { DeploySecretPlanEntry } from "./resolve-secret-scope.ts";
import { CliError, handleError, isMain } from "./runtime-command.ts";

type SecretPlan = {
  schema_version: 1;
  secrets: DeploySecretPlanEntry[];
};
type SecretBundle = Record<string, unknown>;

const namePattern = /^[A-Z][A-Z0-9_]*$/;
const maximumBundleBytes = 48 * 1024;

function addMask(value: string): void {
  const escaped = value
    .replace(/%/g, "%25")
    .replace(/\r/g, "%0D")
    .replace(/\n/g, "%0A");
  process.stdout.write(`::add-mask::${escaped}\n`);
}

function assertPlan(plan: SecretPlan): void {
  if (plan.schema_version !== 1 || !Array.isArray(plan.secrets)) {
    throw new CliError("Deploy Secret plan is invalid.", 65);
  }
  const names = new Set<string>();
  const sources = new Set<string>();
  for (const entry of plan.secrets) {
    if (
      !entry ||
      !namePattern.test(entry.name) ||
      !namePattern.test(entry.source) ||
      typeof entry.required !== "boolean" ||
      !["secret", "variable"].includes(entry.kind) ||
      names.has(entry.name) ||
      sources.has(entry.source)
    ) {
      throw new CliError("Deploy Secret plan contains an invalid or duplicate entry.", 65);
    }
    names.add(entry.name);
    sources.add(entry.source);
  }
}

export async function stageDeploySecretBundle(
  rawBundle: string,
  plan: SecretPlan,
  runnerTemp: string
): Promise<string[]> {
  assertPlan(plan);
  if (!rawBundle) {
    throw new CliError("Product-scoped deployment Secret bundle is unavailable.", 77);
  }
  if (Buffer.byteLength(rawBundle, "utf8") > maximumBundleBytes) {
    throw new CliError(
      "Product-scoped deployment Secret bundle exceeds the GitHub Secret size limit.",
      65
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBundle);
  } catch {
    throw new CliError("Product-scoped deployment Secret bundle must be valid JSON.", 65);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CliError("Product-scoped deployment Secret bundle must be a JSON object.", 65);
  }
  const bundle = parsed as SecretBundle;
  // Register every component value with the runner before validation or any later command can log it.
  for (const value of Object.values(bundle)) {
    if (typeof value === "string" && value.length > 0) {
      addMask(value);
    }
  }
  const secretEntries = plan.secrets.filter((entry) => entry.kind === "secret");
  const expectedSources = new Set(secretEntries.map((entry) => entry.source));
  for (const key of Object.keys(bundle)) {
    if (!expectedSources.has(key)) {
      throw new CliError(
        `Secret bundle contains a source outside the current deployment plan: ${key}.`,
        65
      );
    }
  }
  for (const [key, value] of Object.entries(bundle)) {
    if (!namePattern.test(key) || typeof value !== "string") {
      throw new CliError(`Secret bundle entry is invalid: ${key}.`, 65);
    }
  }

  const directory = join(runnerTemp, deploySecretDirectory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const staged: string[] = [];
  for (const entry of secretEntries) {
    const value = bundle[entry.source];
    if (typeof value !== "string" || value.length === 0) {
      if (entry.required) {
        throw new CliError(
          `Required deploy Secret is missing from the product bundle: ${entry.name}.`,
          77
        );
      }
      continue;
    }
    const path = join(directory, entry.name);
    await writeFile(path, value, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await chmod(path, 0o600);
    staged.push(entry.name);
  }
  return staged;
}

async function main(): Promise<void> {
  const runnerTemp = process.env.RUNNER_TEMP ?? "";
  const rawBundle = process.env.AW_DEPLOY_SECRET_BUNDLE ?? "";
  if (!runnerTemp) {
    throw new CliError("RUNNER_TEMP is not set.", 64);
  }
  const planPath = join(runnerTemp, deploySecretPlanPath);
  const plan = JSON.parse(await readFile(planPath, "utf8")) as SecretPlan;
  const staged = await stageDeploySecretBundle(rawBundle, plan, runnerTemp);
  console.log(
    `Product-scoped deployment Secret bundle staged: ${staged.length} authorized item(s).`
  );
}

if (isMain(import.meta.url)) main().catch(handleError);
