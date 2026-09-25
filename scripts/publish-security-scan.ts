import { gzipSync } from "node:zlib";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  getGithubJson,
  githubEnvironment,
  isJsonRecord,
} from "./github-api.ts";
import {
  CliError,
  handleError,
  isMain,
  runText,
} from "./runtime-command.ts";

const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const shaPattern = /^[0-9a-f]{40}$/;
const refPattern = /^refs\/(?:heads\/[A-Za-z0-9._/-]+|pull\/[1-9][0-9]*\/(?:head|merge))$/;

async function sarifFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true });
  return entries
    .filter((entry) => entry.endsWith(".sarif"))
    .map((entry) => join(root, entry))
    .sort();
}

function stringField(value: unknown, field: string): string {
  if (!isJsonRecord(value) || typeof value[field] !== "string" || value[field].length === 0) {
    throw new CliError(`GitHub SARIF response is missing ${field}.`, 65);
  }
  return value[field] as string;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const [repository = "", sourceSha = "", ref = "", sarifRoot = ""] = process.argv.slice(2);
  const token = process.env.AW_ADMIN_TOKEN ?? "";
  if (!repositoryPattern.test(repository)
    || !shaPattern.test(sourceSha)
    || !refPattern.test(ref)
    || !sarifRoot
    || !token
  ) {
    throw new CliError(
      "Usage: publish-security-scan.ts <repository> <source-sha> <ref> <sarif-root> with AW_ADMIN_TOKEN.",
      64,
    );
  }

  const files = await sarifFiles(sarifRoot);
  if (files.length < 1) {
    throw new CliError("No SARIF files were produced by the security scan.", 66);
  }

  const uploads: string[] = [];
  for (const path of files) {
    const sarif = gzipSync(await readFile(path)).toString("base64");
    const payload = {
      commit_sha: sourceSha,
      ref,
      sarif,
      tool_name: "CodeQL",
      validate: true,
    };
    const responseText = await runText(
      "gh",
      ["api", "--method", "POST", `repos/${repository}/code-scanning/sarifs`, "--input", "-"],
      {
        env: githubEnvironment(token),
        input: JSON.stringify(payload),
        timeoutMs: 60_000,
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    const response = JSON.parse(responseText) as unknown;
    const id = stringField(response, "id");
    uploads.push(id);
  }

  for (const id of uploads) {
    let isCompleted = false;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const status = await getGithubJson(
        `repos/${repository}/code-scanning/sarifs/${id}`,
        token,
      );
      const processing = stringField(status, "processing_status");
      if (processing === "complete") {
        isCompleted = true;
        break;
      }
      if (processing === "failed") {
        throw new CliError(`GitHub rejected SARIF upload: ${id}.`, 65);
      }
      await sleep(Math.min(1000 * (attempt + 1), 5000));
    }
    if (!isCompleted) {
      throw new CliError(`Timed out waiting for SARIF processing: ${id}.`, 124);
    }
  }

  console.log(JSON.stringify({ repository, source_sha: sourceSha, ref, uploads }));
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
