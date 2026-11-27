import { appendFileSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @param {unknown} value @returns {value is string} */
function isExactVersion(value) {
  return typeof value === "string" && /^\d+\.\d+\.\d+$/.test(value);
}

/** @param {Record<string, unknown>} catalog @param {string} key */
function versionFor(catalog, key) {
  const entry = catalog[key];
  if (!isRecord(entry) || entry.class !== "toolchain" || typeof entry.version !== "string") {
    throw new Error("Required runtime baseline is missing.");
  }
  return entry.version;
}

/** @param {unknown} value */
export function parseRuntimeCatalog(value) {
  if (
    !isRecord(value) ||
    value.schema_version !== 1 ||
    !isRecord(value.runtime) ||
    !isRecord(value.catalog)
  ) {
    throw new Error("Central runtime catalog is invalid.");
  }
  const runtime = value.runtime;
  const baseline = versionFor(value.catalog, "tool:node");
  const python = versionFor(value.catalog, "tool:python");
  const pnpm = versionFor(value.catalog, "tool:pnpm");
  if (
    Object.keys(runtime).length !== 2 ||
    typeof runtime.sandbox_node !== "string" ||
    !/^\d+(?:\.\d+\.\d+)?$/.test(runtime.sandbox_node) ||
    !Array.isArray(runtime.compatible_node) ||
    !runtime.compatible_node.every(isExactVersion) ||
    new Set(runtime.compatible_node).size !== runtime.compatible_node.length ||
    runtime.compatible_node.includes(baseline) ||
    !isExactVersion(baseline) ||
    !/^\d+\.\d+(?:\.\d+)?$/.test(python) ||
    !isExactVersion(pnpm)
  ) {
    throw new Error("Central runtime catalog contains an invalid version.");
  }
  return {
    baseline,
    sandboxNode: runtime.sandbox_node,
    compatibleNode: /** @type {string[]} */ (runtime.compatible_node),
    python,
    pnpm,
  };
}

/**
 * The trusted project declaration selects only a centrally allowed exact Node version.
 * No project-supplied installation command, URL, or environment value is executed.
 * @param {unknown} policy
 * @param {string | undefined} nodeDeclaration
 * @param {string | undefined} packageManager
 * @param {boolean} useBaseline
 */
export function resolveRuntimeVersions(policy, nodeDeclaration, packageManager, useBaseline) {
  const runtime = parseRuntimeCatalog(policy);
  const requested = nodeDeclaration?.trim();
  if (
    nodeDeclaration !== undefined &&
    (!isExactVersion(requested) ||
      ![runtime.baseline, ...runtime.compatibleNode].includes(requested))
  ) {
    throw new Error("Project Node version is not an approved exact runtime version.");
  }
  return {
    node: requested ?? (useBaseline ? runtime.baseline : runtime.sandboxNode),
    python: runtime.python,
    pnpm: runtime.pnpm,
    requires_pnpm: packageManager?.startsWith("pnpm@") === true,
  };
}

/** @param {string} path */
function readOptionalFile(path) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
  if (!stat.isFile() || stat.size > 262144) throw new Error("Invalid project runtime declaration.");
  return readFileSync(path, "utf8");
}

/** @param {string | undefined} root */
export function readRuntimePlan(root) {
  const policy = JSON.parse(
    readFileSync(new URL("../policies/dependency-versions.json", import.meta.url), "utf8")
  );
  if (root === undefined) return resolveRuntimeVersions(policy, undefined, undefined, true);
  const nodeDeclaration = readOptionalFile(join(root, ".node-version"));
  const manifest = readOptionalFile(join(root, "package.json"));
  let packageManager;
  if (manifest !== undefined) {
    const value = JSON.parse(manifest);
    if (!isRecord(value)) throw new Error("Invalid project package declaration.");
    if (typeof value.packageManager === "string") packageManager = value.packageManager;
  }
  return resolveRuntimeVersions(policy, nodeDeclaration, packageManager, false);
}

function main() {
  const args = process.argv.slice(2);
  const githubOutput = args[0] === "--github-output";
  const root = githubOutput ? args[1] : args[0];
  if (args.length > (githubOutput ? 2 : 1) || (githubOutput && !root)) {
    throw new Error("Usage: resolve-runtime-versions.mjs [--github-output] [project-directory]");
  }
  const plan = readRuntimePlan(root);
  if (githubOutput) {
    const output = process.env.GITHUB_OUTPUT;
    if (!output) throw new Error("GitHub output file is required.");
    const lines = Object.entries(plan).map(([key, value]) => key + "=" + value);
    appendFileSync(output, lines.join("\n") + "\n", "utf8");
  } else {
    console.log(JSON.stringify(plan, null, 2));
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    main();
  } catch {
    // Avoid printing project paths or private manifest content.
    console.error(
      "Runtime plan could not be resolved; check the central policy and project declarations."
    );
    process.exitCode = 1;
  }
}
