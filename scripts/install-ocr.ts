import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  appendFile,
  chmod,
  copyFile,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import {
  CliError,
  handleError,
  isMain,
  runCommand,
} from "./runtime-command.ts";

async function fileHash(path: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const input = createReadStream(path);
    input.on("error", reject);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("end", () => resolve(hash.digest("hex")));
  });
}

async function verifyAsset(binary: string, checksum: string): Promise<boolean> {
  try {
    const binaryStat = await stat(binary);
    const checksumStat = await stat(checksum);
    if (!binaryStat.isFile() || !checksumStat.isFile() || binaryStat.size === 0 || checksumStat.size === 0) {
      return false;
    }
    const expected = (await readFile(checksum, "utf8")).trim().split(/\s+/)[0] ?? "";
    return /^[0-9a-f]{64}$/.test(expected) && await fileHash(binary) === expected;
  } catch {
    return false;
  }
}

async function downloadFile(url: string, path: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      await writeFile(path, Buffer.from(await response.arrayBuffer()));
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
  }
  throw lastError;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 4) {
    throw new CliError("Usage: install-ocr.ts <repository> <version> <asset> <cache-dir>", 64);
  }
  const [repository = "", version = "", asset = "", cacheDir = ""] = args;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)
    || !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version)
    || !/^[a-z0-9][a-z0-9._-]*$/.test(asset)
    || !cacheDir) {
    throw new CliError("ERROR: invalid OCR installer arguments.", 65);
  }
  const home = process.env.HOME ?? "";
  if (!home) {
    throw new CliError("ERROR: HOME is required.", 65);
  }
  const binary = join(cacheDir, asset);
  const checksum = join(cacheDir, `${asset}.sha256`);
  const binDir = join(home, ".local", "bin");
  const installed = join(binDir, "ocr");
  await mkdir(cacheDir, { recursive: true });
  await mkdir(binDir, { recursive: true });
  if (!await verifyAsset(binary, checksum)) {
    await rm(binary, { force: true });
    await rm(checksum, { force: true });
    const baseUrl = `https://github.com/${repository}/releases/download/open-code-review-v${version}`;
    await downloadFile(`${baseUrl}/${asset}`, binary);
    await downloadFile(`${baseUrl}/${asset}.sha256`, checksum);
    if (!await verifyAsset(binary, checksum)) {
      throw new CliError("ERROR: OCR asset checksum verification failed.", 65);
    }
  }
  await copyFile(binary, installed);
  await chmod(installed, 0o755);
  if (process.env.GITHUB_PATH) {
    await appendFile(process.env.GITHUB_PATH, `${binDir}\n`, "utf8");
  }
  await runCommand(installed, ["--version"]);
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
