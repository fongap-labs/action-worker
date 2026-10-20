import { randomUUID } from "node:crypto";

import { getJsonArray, getJsonString, isJsonRecord, runGithubCli } from "./github-api.ts";
import { isProductName } from "./product-discovery.ts";
import { appendLines, CliError, handleError, isMain, parseJson } from "./runtime-command.ts";

export type DeployGap = {
  product: string;
  missing: string[];
};

const productManifestPattern = /^projects\/([^/]+)\/(?:deploy\.json|release\.manifest\.json)$/;

/**
 * The product directories a pull request touches. Only a product under projects/ needs a central
 * policy entry; a repository with a single product keeps its root manifest and its repository key.
 * A directory name that is not a product name is not a product, so it is skipped.
 */
export function extractProductsFromPaths(paths: readonly string[]): Set<string> {
  const products = new Set<string>();
  for (const path of paths) {
    const match = path.match(productManifestPattern);
    if (match?.[1] && isProductName(match[1])) {
      products.add(match[1]);
    }
  }
  return products;
}

/**
 * The central policy key of one product of one repository. A product key is the repository key
 * plus the product name; a repository key never counts as a product key.
 */
export function productPolicyKey(repository: string, product: string): string {
  return `${repository}/${product}`;
}

export function hasProductPolicyKey(
  keys: readonly string[],
  repository: string,
  product: string
): boolean {
  return keys.includes(productPolicyKey(repository, product));
}

/**
 * The hint lists the central files that need an entry for the product. It is advisory: a product
 * that is never deployed needs no entry, and the files are named so the author can copy the shape.
 */
export function formatGapHint(gaps: readonly DeployGap[]): string {
  if (gaps.length === 0) {
    return "";
  }
  const lines = ["", "### Deploy Configuration Gaps", ""];
  for (const gap of gaps) {
    lines.push(`- Product \`${gap.product}\` has no central deploy policy entry:`);
    for (const file of gap.missing) {
      lines.push(`  - \`policies/${file}\` needs a \`${gap.product}\` entry for this repository`);
    }
  }
  lines.push(
    "",
    "_A product that is never deployed needs no entry. Otherwise add one, then re-run governance._"
  );
  return lines.join("\n");
}

/**
 * The file names of a paginated pull request files response. --paginate with --slurp answers with
 * one array per page, so the pages are flattened before the names are read.
 */
export function parsePullRequestFiles(response: string): string[] {
  const pages = JSON.parse(response) as unknown;
  const files = Array.isArray(pages)
    ? pages.flatMap((page) => (Array.isArray(page) ? page : []))
    : getJsonArray(pages);
  return files
    .filter((file) => isJsonRecord(file) && typeof file.filename === "string")
    .map((file) => file.filename);
}

/**
 * The files of a pull request. The compare endpoint truncates its file list, so the pull request
 * files endpoint is used instead.
 */
export async function listPullRequestFiles(
  repository: string,
  prNumber: number,
  token: string
): Promise<string[]> {
  const response = await runGithubCli(
    ["api", "--paginate", "--slurp", `repos/${repository}/pulls/${prNumber}/files?per_page=100`],
    token
  );
  return parsePullRequestFiles(response);
}

function policyKeys(document: unknown, section: string): string[] {
  if (!isJsonRecord(document)) {
    return [];
  }
  const value = document[section];
  if (!isJsonRecord(value)) {
    return [];
  }
  return Object.keys(value);
}

async function readPolicyKeys(
  repository: string,
  path: string,
  section: string,
  token: string
): Promise<string[]> {
  const response = await runGithubCli(
    ["api", `repos/${repository}/contents/${path}?ref=main`],
    token
  );
  const record = JSON.parse(response) as unknown;
  if (!isJsonRecord(record)) {
    throw new CliError(`Invalid policy response for ${path}.`, 65);
  }
  const encoding = getJsonString(record, "encoding");
  const content = getJsonString(record, "content");
  if (encoding !== "base64" || content === "") {
    throw new CliError(`Policy file ${path} is not readable as base64 content.`, 65);
  }
  const document = parseJson(
    Buffer.from(content.replace(/\n/g, ""), "base64").toString("utf8"),
    `Policy file ${path} must be valid JSON.`,
    65
  );
  return policyKeys(document, section);
}

/**
 * The gaps of the products, given the central policy keys. The product key belongs to the target
 * repository, so a product of another repository never satisfies the lookup.
 */
export function gapsForKeys(
  environmentKeys: readonly string[],
  secretKeys: readonly string[],
  targetRepository: string,
  products: ReadonlySet<string>
): DeployGap[] {
  const gaps: DeployGap[] = [];
  for (const product of [...products].sort()) {
    const missing: string[] = [];
    if (!hasProductPolicyKey(environmentKeys, targetRepository, product)) {
      missing.push("deploy-environments.json");
    }
    if (!hasProductPolicyKey(secretKeys, targetRepository, product)) {
      missing.push("deploy-secrets.json");
    }
    if (missing.length > 0) {
      gaps.push({ product, missing });
    }
  }
  return gaps;
}

export async function collectGaps(
  policyRepository: string,
  targetRepository: string,
  products: ReadonlySet<string>,
  token: string
): Promise<DeployGap[]> {
  const environmentKeys = await readPolicyKeys(
    policyRepository,
    "policies/deploy-environments.json",
    "repositories",
    token
  );
  const secretKeys = await readPolicyKeys(
    policyRepository,
    "policies/deploy-secrets.json",
    "deployments",
    token
  );
  return gapsForKeys(environmentKeys, secretKeys, targetRepository, products);
}

export async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length < 4) {
    throw new CliError(
      "Usage: check-deploy-gap.ts <control-repo> <target-repo> <pr-number> <token>",
      64
    );
  }
  const [controlRepo, targetRepo, rawPrNumber, token] = args as [string, string, string, string];
  if (!/^[1-9][0-9]*$/.test(rawPrNumber)) {
    throw new CliError(`::error::Invalid pull request number: ${rawPrNumber}.`, 64);
  }
  const prNumber = Number.parseInt(rawPrNumber, 10);
  const files = await listPullRequestFiles(targetRepo, prNumber, token);
  const products = extractProductsFromPaths(files);
  if (products.size === 0) {
    await writeHint("");
    return;
  }
  const gaps = await collectGaps(controlRepo, targetRepo, products, token);
  await writeHint(formatGapHint(gaps));
}

// The hint can span several lines, so it is written as a heredoc output value. The delimiter is
// unique so that nothing in the hint can end the heredoc early.
async function writeHint(hint: string): Promise<void> {
  console.log(hint);
  const output = process.env.GITHUB_OUTPUT;
  if (!output) {
    return;
  }
  const delimiter = `EOF_${randomUUID()}`;
  await appendLines(output, [`hint<<${delimiter}`, hint, delimiter]);
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
