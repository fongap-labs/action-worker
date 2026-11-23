import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";
import { deltaCleanRootSha, deltaCleanRootTreeSha } from "./delta-clean-root.ts";
import { CliError } from "./runtime-command.ts";

const bridgePath = ".github/workflows/notify-action-worker.yml";
const allowedFiles = new Set(["LICENSE", "README.md", "AGENTS.md", "CLAUDE.md", "CHANGELOG.md"]);
const editableDocs = new Set(["README.md", "AGENTS.md", "CLAUDE.md", "CHANGELOG.md"]);
const requiredFiles = ["LICENSE", "README.md", "AGENTS.md", "CLAUDE.md", "CHANGELOG.md"];
const shaPattern = /^[0-9a-f]{40}$/;

type GitEntry = { mode: string; type: string; sha: string; path: string };

function git(cwd: string, args: string[]): Buffer {
  return execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 2 * 1024 * 1024,
    timeout: 15_000,
  });
}

export function parseDocsTree(output: string): GitEntry[] {
  if (!output) return [];
  if (!output.endsWith("\0")) throw new CliError("Delta docs Git tree is incomplete.", 65);
  return output
    .slice(0, -1)
    .split("\0")
    .map((line) => {
      const separator = line.indexOf("\t");
      if (separator < 0) throw new CliError("Delta docs Git tree is malformed.", 65);
      const metadata = line.slice(0, separator).split(" ");
      if (metadata.length !== 3) throw new CliError("Delta docs Git mode is malformed.", 65);
      return {
        mode: metadata[0] ?? "",
        type: metadata[1] ?? "",
        sha: metadata[2] ?? "",
        path: line.slice(separator + 1),
      };
    });
}

export function verifyDeltaDocsTree(
  entries: GitEntry[],
  changes: string[],
  trustedBridgeBlobSha = ""
): void {
  const paths = new Set<string>();
  for (const entry of entries) {
    if (
      (!allowedFiles.has(entry.path) &&
        !(
          entry.path === bridgePath &&
          trustedBridgeBlobSha !== "" &&
          entry.sha === trustedBridgeBlobSha
        )) ||
      paths.has(entry.path) ||
      entry.mode !== "100644" ||
      entry.type !== "blob" ||
      !shaPattern.test(entry.sha)
    ) {
      throw new CliError("Delta docs bootstrap must contain only reviewed regular documents.", 65);
    }
    paths.add(entry.path);
  }
  if (requiredFiles.some((path) => !paths.has(path))) {
    throw new CliError("Delta docs bootstrap is missing a required document.", 65);
  }
  if (
    changes.length === 0 ||
    changes.some((line) => {
      const fields = line.split("\t");
      return (
        fields.length !== 2 ||
        !["A", "M"].includes(fields[0] ?? "") ||
        !editableDocs.has(fields[1] ?? "")
      );
    })
  ) {
    throw new CliError("Delta docs bootstrap changed files outside the document allowlist.", 65);
  }
}

export function verifyDeltaDocsTrustAnchor(
  controlSha: string,
  base: string,
  head: string,
  prNumber: string,
  rootTree: string
): void {
  // The source-owned ci-control checkout is the PR base for pull requests and
  // the exact main HEAD for ref checks. It is never the Action Worker commit.
  if (!/^(0|[1-9][0-9]*)$/.test(prNumber)) {
    throw new CliError("Delta docs central CI PR identity is invalid.", 65);
  }
  const expectedSha = prNumber === "0" ? head : base;
  if (!shaPattern.test(controlSha) || controlSha !== expectedSha || rootTree !== deltaCleanRootTreeSha) {
    throw new CliError("Delta docs control checkout or trusted root does not match.", 65);
  }
}

/**
 * The new Delta main has no product code or execution manifest. For its initial
 * documentation-only phase, run a fail-closed, centrally owned Git/content audit.
 * This does NOT approve any source/test/build/config change or claim app tests ran.
 */
export function verifyDeltaDocsBootstrap(
  targetRoot: string,
  controlRoot: string,
  base: string,
  head: string,
  shard = "all"
): void {
  if (
    process.env.TARGET_REPOSITORY !== "fongap-labs/delta" ||
    process.env.TARGET_PRIVATE !== "false" ||
    !shaPattern.test(base) ||
    !shaPattern.test(head) ||
    base === head ||
    shard !== "all"
  ) {
    throw new CliError("Delta docs bootstrap is restricted to public Delta documentation PRs.", 65);
  }
  const workerRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const controlSha = git(controlRoot, ["rev-parse", "HEAD"]).toString("utf8").trim();
  const rootTree = git(targetRoot, ["rev-parse", `${deltaCleanRootSha}^{tree}`])
    .toString("utf8")
    .trim();
  verifyDeltaDocsTrustAnchor(
    controlSha,
    base,
    head,
    process.env.CENTRAL_CI_PR_NUMBER ?? "",
    rootTree
  );
  for (const pair of [
    [deltaCleanRootSha, base],
    [base, head],
  ]) {
    try {
      git(targetRoot, ["merge-base", "--is-ancestor", pair[0] ?? "", pair[1] ?? ""]);
    } catch {
      throw new CliError("Delta docs PR does not descend from the trusted clean root.", 65);
    }
  }
  const entries = parseDocsTree(
    git(targetRoot, ["ls-tree", "-rz", "--full-tree", head]).toString("utf8")
  );
  const diff = git(targetRoot, [
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--no-renames",
    "--name-status",
    "-z",
    base,
    head,
    "--",
  ]).toString("utf8");
  if (!diff.endsWith("\0")) throw new CliError("Delta docs Git diff is incomplete.", 65);
  const items = diff.slice(0, -1).split("\0");
  if (items.length % 2 !== 0) throw new CliError("Delta docs Git diff is malformed.", 65);
  const changes: string[] = [];
  for (let i = 0; i < items.length; i += 2) changes.push(`${items[i]}\t${items[i + 1]}`);
  const template = readFileSync(join(workerRoot, "templates/bridge/notify-action-worker.yml"));
  const trustedBridgeBlobSha = createHash("sha1")
    .update(`blob ${template.length}\0`)
    .update(template)
    .digest("hex");
  verifyDeltaDocsTree(entries, changes, trustedBridgeBlobSha);

  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (const file of requiredFiles.filter((path) => path.endsWith(".md"))) {
    const contents = git(targetRoot, ["show", `${head}:${file}`]);
    if (contents.length === 0 || contents.length > 64 * 1024) {
      throw new CliError("Delta documentation content size is invalid.", 65);
    }
    let value: string;
    try {
      value = decoder.decode(contents);
    } catch {
      throw new CliError("Delta documentation must be valid UTF-8.", 65);
    }
    if (!value.startsWith("# ") || !value.endsWith("\n") || value.includes("\0")) {
      throw new CliError("Delta documentation heading, newline or text is invalid.", 65);
    }
  }
  console.log(
    "Delta docs-only bootstrap verified: tracked files, ancestry, modes and UTF-8; no app code exists."
  );
}
