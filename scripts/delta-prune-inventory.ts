import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DeltaPrunePolicy, parseDeltaPrunePolicy } from "./delta-prune-policy.ts";
import { isJsonRecord } from "./github-api.ts";
import { CliError, runCommand, runText } from "./runtime-command.ts";

const shaPattern = /^[a-f0-9]{40}$/;
const dependencyFields = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

type TreeEntry = { path: string; mode: string; kind: string; sha: string };

export function parseDeltaPruneTree(raw: string): TreeEntry[] {
  if (!raw.endsWith("\0")) throw new CliError("Incomplete Delta source tree.", 65);
  const entries: TreeEntry[] = [];
  const seen = new Set<string>();
  for (const record of raw.slice(0, -1).split("\0")) {
    const match = /^([0-7]{6}) (blob|commit) ([a-f0-9]{40})\t([\s\S]+)$/.exec(record);
    if (!match?.[1] || !match[2] || !match[3] || !match[4] || seen.has(match[4])) {
      throw new CliError("Invalid Delta source tree entry.", 65);
    }
    const [, mode, kind, sha, path] = match;
    seen.add(path);
    entries.push({ path, mode, kind, sha });
  }
  return entries;
}

function aliasTarget(specifier: string): string | undefined {
  return /^(?:npm|workspace):((?:@[^/@]+\/)?[^/@:]+)@/.exec(specifier)?.[1];
}

/** Inspect only immutable paths and package declarations, never execute product code. */
export function inspectDeltaPruneInventory(
  policy: DeltaPrunePolicy,
  entries: readonly TreeEntry[],
  manifests: ReadonlyMap<string, string>
): string[] {
  const findings = new Set<string>();
  const deniedPackages = new Set(policy.deniedPackages);
  const deniedDependencies = new Set(policy.deniedDependencies);
  const allowedEntrypoints = new Set(policy.allowedEntrypoints);
  const manifestPaths = new Set<string>();
  for (const entry of entries) {
    const { path } = entry;
    const app = /^apps\/[^/]+/.exec(path)?.[0];
    if (app && !allowedEntrypoints.has(app)) findings.add("Unapproved application root: " + app);
    for (const denied of deniedPackages) {
      if (path === denied || path.startsWith(denied + "/")) {
        findings.add("Denied package path: " + denied);
      }
    }
    if (path !== "package.json" && !path.endsWith("/package.json")) continue;
    manifestPaths.add(path);
    if (entry.kind !== "blob" || !["100644", "100755"].includes(entry.mode)) {
      findings.add("Non-regular package manifest: " + path);
      continue;
    }
    const content = manifests.get(path);
    if (content === undefined) {
      findings.add("Missing package manifest evidence: " + path);
      continue;
    }
    let manifest: unknown;
    try {
      manifest = JSON.parse(content);
    } catch {
      findings.add("Invalid package manifest: " + path);
      continue;
    }
    if (!isJsonRecord(manifest)) {
      findings.add("Invalid package manifest: " + path);
      continue;
    }
    if (typeof manifest.name === "string" && deniedPackages.has(manifest.name)) {
      findings.add("Denied package name: " + manifest.name + " in " + path);
    }
    for (const field of dependencyFields) {
      const dependencies = manifest[field];
      if (dependencies === undefined) continue;
      if (!isJsonRecord(dependencies)) {
        findings.add("Invalid dependency declarations: " + path + " " + field);
        continue;
      }
      for (const [name, specifier] of Object.entries(dependencies)) {
        if (typeof specifier !== "string") {
          findings.add("Invalid dependency declaration: " + path + " " + name);
          continue;
        }
        const alias = aliasTarget(specifier);
        for (const candidate of alias === undefined ? [name] : [name, alias]) {
          if (deniedDependencies.has(candidate) || deniedPackages.has(candidate)) {
            findings.add("Denied dependency: " + candidate + " in " + path);
          }
        }
      }
    }
    for (const field of ["bundledDependencies", "bundleDependencies"]) {
      const bundled = manifest[field];
      if (bundled === undefined || typeof bundled === "boolean") continue;
      if (!Array.isArray(bundled) || !bundled.every((name) => typeof name === "string")) {
        findings.add("Invalid bundled dependency declarations: " + path);
        continue;
      }
      for (const name of bundled) {
        if (deniedDependencies.has(name) || deniedPackages.has(name)) {
          findings.add("Denied bundled dependency: " + name + " in " + path);
        }
      }
    }
  }
  if (!manifestPaths.has("package.json")) findings.add("Missing root package manifest");
  for (const path of manifests.keys()) {
    if (!manifestPaths.has(path)) findings.add("Unexpected package manifest evidence: " + path);
  }
  return [...findings].sort();
}

export async function auditDeltaPruneInventory(
  candidate: string,
  rawPolicy: string
): Promise<void> {
  if (!shaPattern.test(candidate)) throw new CliError("Invalid Delta pruning revision.", 65);
  const { policy, digest } = parseDeltaPrunePolicy(rawPolicy, Date.now());
  const root = mkdtempSync(join(tmpdir(), "aw-delta-prune-"));
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
  };
  try {
    await runCommand("git", ["init", "--bare", "-q", root], { env, timeoutMs: 30_000 });
    await runCommand(
      "git",
      [
        "-C",
        root,
        "fetch",
        "--quiet",
        "--no-tags",
        "--no-recurse-submodules",
        "--depth=1",
        "https://github.com/fongap-labs/delta.git",
        candidate,
      ],
      { env, timeoutMs: 180_000 }
    );
    const actual = await runText("git", ["-C", root, "rev-parse", "--verify", candidate + "^{commit}"], {
      env,
      timeoutMs: 30_000,
    });
    if (actual !== candidate) throw new CliError("Delta pruning revision mismatch.", 65);
    const tree = await runCommand("git", ["-C", root, "ls-tree", "-r", "-z", candidate], {
      env,
      timeoutMs: 30_000,
    });
    const entries = parseDeltaPruneTree(tree.toString("utf8"));
    const manifests = new Map<string, string>();
    const selected = entries.filter(
      (entry) =>
        (entry.path === "package.json" || entry.path.endsWith("/package.json")) &&
        entry.kind === "blob" &&
        ["100644", "100755"].includes(entry.mode)
    );
    for (let start = 0; start < selected.length; start += 8) {
      await Promise.all(
        selected.slice(start, start + 8).map(async (entry) => {
          const content = await runCommand("git", ["-C", root, "cat-file", "blob", entry.sha], {
            env,
            maxBuffer: 1024 * 1024,
            timeoutMs: 10_000,
          });
          manifests.set(entry.path, content.toString("utf8"));
        })
      );
    }
    const findings = inspectDeltaPruneInventory(policy, entries, manifests);
    console.log(
      JSON.stringify({
        check: "delta-prune-static-inventory",
        candidate,
        policyDigest: digest,
        manifestCount: manifests.size,
        findings,
      })
    );
    if (findings.length > 0) {
      throw new CliError("Delta static pruning inventory denied " + findings.length + " item(s).", 65);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
