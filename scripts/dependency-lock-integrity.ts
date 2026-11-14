import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CliError, handleError, isMain, runText } from "./runtime-command.ts";

// Offline integrity checks only: never contact a registry or run target install scripts.
// This is a supply-chain preflight, not a replacement for a vulnerability database scan.
export function inspectNpmLock(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CliError("Invalid npm lockfile root.", 65);
  }
  const lock = value as Record<string, unknown>;
  if (![2, 3].includes(lock.lockfileVersion as number)) {
    throw new CliError("Unsupported npm lockfile version.", 65);
  }
  if (!lock.packages || typeof lock.packages !== "object" || Array.isArray(lock.packages)) {
    throw new CliError("npm lockfile package index is missing.", 65);
  }
  const packages = Object.entries(lock.packages as Record<string, unknown>);
  if (packages.length > 100_000) {
    throw new CliError("npm lockfile exceeds the analysis budget.", 65);
  }
  const violations: string[] = [];
  for (const [name, item] of packages) {
    if (!name || !item || typeof item !== "object" || Array.isArray(item)) continue;
    const entry = item as Record<string, unknown>;
    if (entry.link === true || entry.inBundle === true) continue;
    const resolved = entry.resolved;
    if (resolved === undefined) continue;
    if (typeof resolved !== "string") {
      violations.push("invalid-resolution");
      continue;
    }
    // file/workspace links are not remote fetches and do not need registry integrity.
    if (resolved.startsWith("file:") || resolved.startsWith("link:")) continue;
    let url: URL;
    try {
      url = new URL(resolved.replace(/^git\+/, ""));
    } catch {
      violations.push("unparseable-resolution");
      continue;
    }
    if (url.password || (url.username && url.protocol !== "ssh:" && !resolved.startsWith("git+"))) {
      violations.push("embedded-registry-credentials");
    }
    if (url.protocol === "http:") violations.push("insecure-registry-transport");
    if (url.protocol !== "https:" && url.protocol !== "ssh:") {
      violations.push("unsupported-remote-transport");
    }
    if (
      url.protocol === "https:" &&
      !resolved.startsWith("git+") &&
      (typeof entry.integrity !== "string" ||
        !/^(?:sha512|sha384|sha256)-[A-Za-z0-9+/=]+$/.test(entry.integrity))
    ) {
      violations.push("missing-lockfile-integrity");
    }
    if (
      (resolved.startsWith("git+") || url.protocol === "ssh:") &&
      !/#[a-f0-9]{40}(?:$|[?&])/i.test(resolved)
    ) {
      violations.push("unlocked-git-revision");
    }
  }
  return [...new Set(violations)].sort();
}

export async function checkChangedNpmLocks(
  root: string,
  base: string,
  head: string
): Promise<string[]> {
  if (!/^[a-f0-9]{40}$/.test(base) || !/^[a-f0-9]{40}$/.test(head)) {
    throw new CliError("Dependency gate requires full commit SHAs.", 64);
  }
  const diff = await runText(
    "git",
    ["diff", "--name-only", "--diff-filter=ACMR", base, head, "--"],
    { cwd: root }
  );
  const dirs = new Set<string>();
  for (const path of diff.split(/\r?\n/)) {
    if (/(^|\/)(?:package\.json|package-lock\.json|npm-shrinkwrap\.json)$/.test(path)) {
      dirs.add(dirname(path));
    }
  }
  const findings: string[] = [];
  for (const dir of dirs) {
    const filePath = join(root, dir, "npm-shrinkwrap.json");
    const alternate = join(root, dir, "package-lock.json");
    let text: string;
    try {
      text = await readFile(filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new CliError("npm lockfile read failed.", 65);
      }
      try {
        text = await readFile(alternate, "utf8");
      } catch (other) {
        if ((other as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw new CliError("npm lockfile read failed.", 65);
      }
    }
    let lock: unknown;
    try {
      lock = JSON.parse(text);
    } catch {
      throw new CliError("npm lockfile is malformed.", 65);
    }
    findings.push(...inspectNpmLock(lock));
  }
  return [...new Set(findings)].sort();
}

async function main(): Promise<void> {
  const [root = "", base = "", head = ""] = process.argv.slice(2);
  if (!root || !base || !head) {
    throw new CliError(
      "Usage: dependency-lock-integrity.ts <target-root> <base-sha> <head-sha>",
      64
    );
  }
  const findings = await checkChangedNpmLocks(root, base, head);
  for (const code of findings) {
    console.error(`::error::Dependency integrity violation [${code}]; source details suppressed.`);
  }
  if (findings.length) {
    throw new CliError(`Dependency integrity gate failed (${findings.length} categories).`, 1);
  }
  console.log("Dependency integrity gate passed (offline npm lockfile preflight).");
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
