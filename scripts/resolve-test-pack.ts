import { readFile } from "node:fs/promises";
import { appendLines, CliError, handleError, isMain, parseJson } from "./runtime-command.ts";

const packPattern = /^[a-z][a-z0-9-]*$/;
const refPattern = /^[0-9a-f]{40}$/;

export type TestPackConfig = { pack: string; ref: string };

export function parseTestPackConfig(text: string): TestPackConfig {
  const value = parseJson(text, "Test pack config is not valid JSON.", 65);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CliError("Test pack config must be an object.", 65);
  }
  const record = value as Record<string, unknown>;
  const extra = Object.keys(record).filter(
    (key) => !["schema_version", "pack", "ref"].includes(key)
  );
  if (extra.length > 0) {
    throw new CliError(`Test pack config has unexpected fields: ${extra.join(", ")}.`, 65);
  }
  if (record.schema_version !== 1) {
    throw new CliError("Test pack config schema_version must be 1.", 65);
  }
  const { pack, ref } = record;
  if (typeof pack !== "string" || !packPattern.test(pack)) {
    throw new CliError("Test pack name is invalid.", 65);
  }
  if (typeof ref !== "string" || !refPattern.test(ref)) {
    throw new CliError("Test pack ref must be a full 40-character commit SHA.", 65);
  }
  return { pack, ref };
}

async function main(): Promise<void> {
  const [path = ""] = process.argv.slice(2);
  if (!path) {
    throw new CliError("Usage: resolve-test-pack.ts <test-pack.json>", 64);
  }
  const config = parseTestPackConfig(await readFile(path, "utf8"));
  await appendLines(process.env.GITHUB_OUTPUT, [`pack=${config.pack}`, `ref=${config.ref}`]);
  console.log(JSON.stringify(config));
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
