import { createHash } from "node:crypto";
import { appendLines, CliError, handleError, isMain } from "./runtime-command.ts";

export function prTitleFingerprint(title: string): string {
  return createHash("sha256").update(title, "utf8").digest("hex");
}

async function main(): Promise<void> {
  const title = process.argv.slice(2).join(" ");
  if (process.argv.length < 3 || !title) {
    throw new CliError("Usage: pr-title-fingerprint.ts <title>", 64);
  }
  const fingerprint = prTitleFingerprint(title);
  await appendLines(process.env.GITHUB_OUTPUT, [`fingerprint=${fingerprint}`]);
  console.log(fingerprint);
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
