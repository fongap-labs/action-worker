import { GithubReader, isJsonRecord, runGithubCli } from "./github-api.ts";
import { CliError, handleError, isMain, parseJson } from "./runtime-command.ts";

type DeployGap = {
  product: string;
  missing: string[];
};

async function getChangedFiles(
  repository: string,
  baseSha: string,
  headSha: string,
  token: string
): Promise<string[]> {
  const response = await runGithubCli(
    ["api", "--paginate", "--slurp", `repos/${repository}/compare/${baseSha}...${headSha}`],
    token
  );
  const data = JSON.parse(response) as unknown;
  if (!isJsonRecord(data) || !Array.isArray(data.files)) {
    throw new CliError("Invalid compare response", 65);
  }
  return data.files
    .filter((f) => isJsonRecord(f) && typeof f.filename === "string")
    .map((f) => f.filename);
}

function extractProductsFromPaths(paths: string[]): Set<string> {
  const products = new Set<string>();
  for (const path of paths) {
    const match = path.match(/^projects\/([^/]+)\/(?:deploy\.json|release\.manifest\.json)$/);
    if (match?.[1]) {
      products.add(match[1]);
    }
  }
  return products;
}

async function checkPolicyGaps(
  reader: GithubReader,
  controlRepository: string,
  products: Set<string>
): Promise<DeployGap[]> {
  const gaps: DeployGap[] = [];
  const policiesRef = "main";

  let deployEnvs: Record<string, string[]> = {};
  let deploySecrets: Record<string, string[]> = {};

  try {
    const envsResponse = await reader.get(
      `repos/${controlRepository}/contents/policies/deploy-environments.json?ref=${policiesRef}`
    );
    const envsRecord = envsResponse as { content?: string; encoding?: string };
    if (envsRecord.content && envsRecord.encoding === "base64") {
      deployEnvs = parseJson(
        Buffer.from(envsRecord.content, "base64").toString("utf8"),
        "deploy-environments.json must be valid JSON",
        65
      ) as Record<string, string[]>;
    }
  } catch {
    // If no policy file, all products are gaps
  }

  try {
    const secretsResponse = await reader.get(
      `repos/${controlRepository}/contents/policies/deploy-secrets.json?ref=${policiesRef}`
    );
    const secretsRecord = secretsResponse as { content?: string; encoding?: string };
    if (secretsRecord.content && secretsRecord.encoding === "base64") {
      deploySecrets = parseJson(
        Buffer.from(secretsRecord.content, "base64").toString("utf8"),
        "deploy-secrets.json must be valid JSON",
        65
      ) as Record<string, string[]>;
    }
  } catch {
    // If no policy file, all products are gaps
  }

  for (const product of products) {
    const missing: string[] = [];
    // Product key format: owner/name/product
    // We don't know owner/name here, so check if ANY key ends with /<product>
    const envKeys = Object.keys(deployEnvs).filter((k) => k.endsWith(`/${product}`));
    const secretKeys = Object.keys(deploySecrets).filter((k) => k.endsWith(`/${product}`));
    if (envKeys.length === 0) missing.push("deploy-environments.json");
    if (secretKeys.length === 0) missing.push("deploy-secrets.json");
    if (missing.length > 0) {
      gaps.push({ product, missing });
    }
  }
  return gaps;
}

function formatGapHint(gaps: DeployGap[]): string {
  if (gaps.length === 0) return "";
  const lines = ["", "### Deploy Configuration Gaps", ""];
  for (const gap of gaps) {
    lines.push(`- Product \`${gap.product}\` is missing central policy entries:`);
    for (const m of gap.missing) {
      lines.push(`  - \`policies/${m}\` needs a \`${gap.product}\` entry`);
    }
  }
  lines.push("", "_Add the missing entries to the central policy files and re-run governance._");
  return lines.join("\n");
}

export async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length < 5) {
    throw new CliError(
      "Usage: check-deploy-gap.ts <control-repo> <target-repo> <base-sha> <head-sha> <token>",
      64
    );
  }
  const [controlRepo, targetRepo, baseSha, headSha, token] = args as [
    string,
    string,
    string,
    string,
    string,
  ];
  const reader = new GithubReader("https://api.github.com", token);
  const files = await getChangedFiles(targetRepo, baseSha, headSha, token);
  const products = extractProductsFromPaths(files);
  if (products.size === 0) {
    console.log("");
    return;
  }
  const gaps = await checkPolicyGaps(reader, controlRepo, products);
  console.log(formatGapHint(gaps));
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
