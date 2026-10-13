import { type FollowManifest, type PinValue, parseFollowManifest } from "./follow-pins.ts";
import {
  GithubHttpError,
  GithubReader,
  getJsonArray,
  getJsonString,
  githubEnvironment,
  isJsonRecord,
} from "./github-api.ts";
import { isRepositoryRelativePath } from "./product-discovery.ts";
import { CliError, runCommand } from "./runtime-command.ts";

// GitHub access for following. Reads go through the contents, refs and releases APIs; writes go
// through the git data API so a change lands as one commit on one branch. Nothing here runs code
// from a repository: repository content is only fetched and parsed.

export type JsonReader = { get(path: string): Promise<unknown> };

const shaPattern = /^[0-9a-f]{40}$/;
const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

// A missing object answers 404; for the read helpers that is an answer, not a failure.
async function getOrNull(reader: JsonReader, path: string): Promise<unknown | null> {
  try {
    return await reader.get(path);
  } catch (error) {
    if (error instanceof GithubHttpError && error.status === 404) return null;
    throw error;
  }
}

/** The commit a tag points to. An annotated tag is followed once; a chain of tags is refused. */
export async function resolveTagCommit(
  reader: JsonReader,
  repository: string,
  tag: string
): Promise<string | null> {
  const ref = await getOrNull(reader, `repos/${repository}/git/ref/tags/${tag}`);
  if (ref === null) return null;
  const object = isJsonRecord(ref) ? ref.object : undefined;
  const type = getJsonString(object, "type");
  const sha = getJsonString(object, "sha");
  if (!shaPattern.test(sha)) {
    throw new CliError(`Tag object is invalid in ${repository}: ${tag}.`, 65);
  }
  if (type === "commit") return sha;
  if (type !== "tag") {
    throw new CliError(`Tag ${tag} in ${repository} points to an unexpected object type.`, 65);
  }
  const annotated = await reader.get(`repos/${repository}/git/tags/${sha}`);
  const target = isJsonRecord(annotated) ? annotated.object : undefined;
  if (
    getJsonString(target, "type") !== "commit" ||
    !shaPattern.test(getJsonString(target, "sha"))
  ) {
    throw new CliError(`Annotated tag ${tag} in ${repository} must point to a commit.`, 65);
  }
  return getJsonString(target, "sha");
}

/** A release exists for the tag and is not a draft. The tag alone is not a published release. */
export async function isPublishedRelease(
  reader: JsonReader,
  repository: string,
  tag: string
): Promise<boolean> {
  const release = await getOrNull(reader, `repos/${repository}/releases/tags/${tag}`);
  return isJsonRecord(release) && release.draft !== true;
}

/**
 * Whether a published release of the upstream confirms a pin value: a version pin needs the tag of
 * that version, and a commit pin needs a published tag of the release key that points to that commit.
 */
export async function isPinPublished(
  reader: JsonReader,
  upstream: string,
  releaseKey: string,
  kind: PinValue,
  value: string
): Promise<boolean> {
  if (kind === "version") {
    const tag = `${releaseKey}-v${value}`;
    const commit = await resolveTagCommit(reader, upstream, tag);
    return commit !== null && (await isPublishedRelease(reader, upstream, tag));
  }
  const refs = await getOrNull(reader, `repos/${upstream}/git/matching-refs/tags/${releaseKey}-v`);
  for (const ref of Array.isArray(refs) ? refs : []) {
    const name = getJsonString(ref, "ref").replace(/^refs\/tags\//, "");
    if (!name.startsWith(`${releaseKey}-v`)) continue;
    if (!semverPattern.test(name.slice(releaseKey.length + 2))) continue;
    const commit = await resolveTagCommit(reader, upstream, name);
    if (commit === value && (await isPublishedRelease(reader, upstream, name))) return true;
  }
  return false;
}

// Repository files are read at one commit; the path is repository-relative and never executed.
export async function readFileAt(
  reader: JsonReader,
  repository: string,
  path: string,
  sha: string,
  maxBytes = 256 * 1024
): Promise<string | null> {
  if (!isRepositoryRelativePath(path)) {
    throw new CliError(`Repository path is invalid: ${path}.`, 65);
  }
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  const response = await getOrNull(reader, `repos/${repository}/contents/${encoded}?ref=${sha}`);
  if (response === null) return null;
  if (
    !isJsonRecord(response) ||
    response.encoding !== "base64" ||
    typeof response.content !== "string"
  ) {
    throw new CliError(`GitHub contents response is invalid: ${repository}/${path}.`, 65);
  }
  const text = Buffer.from(response.content.replace(/\s+/g, ""), "base64").toString("utf8");
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    throw new CliError(`Repository file is larger than ${maxBytes} bytes: ${path}.`, 65);
  }
  return text;
}

export type FollowFile = {
  // Empty for the root layout (.github/follows.json); the product directory name otherwise.
  product: string;
  path: string;
  manifest: FollowManifest;
};

/**
 * The follow declarations of a repository, read from one tree of its default branch: the root
 * layout's .github/follows.json and each product's projects/<name>/follows.json.
 */
export async function listFollowFiles(
  reader: JsonReader,
  repository: string,
  sha: string
): Promise<FollowFile[]> {
  const tree = await reader.get(`repos/${repository}/git/trees/${sha}?recursive=1`);
  if (!isJsonRecord(tree) || !Array.isArray(tree.tree)) {
    throw new CliError(`GitHub tree response is invalid: ${repository}.`, 65);
  }
  if (tree.truncated === true) {
    throw new CliError(
      `Repository tree is truncated, so follow declarations cannot be listed: ${repository}.`,
      65
    );
  }
  const paths = getJsonArray(tree, "tree")
    .filter(isJsonRecord)
    .filter((entry) => entry.type === "blob")
    .map((entry) => getJsonString(entry, "path"));
  const candidates: Array<{ product: string; path: string }> = [];
  if (paths.includes(".github/follows.json")) {
    candidates.push({ product: "", path: ".github/follows.json" });
  }
  for (const path of paths) {
    const match = /^projects\/([A-Za-z0-9][A-Za-z0-9._-]{0,63})\/follows\.json$/.exec(path);
    if (match?.[1] !== undefined) candidates.push({ product: match[1], path });
  }

  const files: FollowFile[] = [];
  for (const candidate of candidates) {
    const text = await readFileAt(reader, repository, candidate.path, sha);
    if (text === null) continue;
    let value: unknown;
    try {
      value = JSON.parse(text) as unknown;
    } catch {
      throw new CliError(
        `Follow manifest must be valid JSON: ${repository}/${candidate.path}.`,
        65
      );
    }
    files.push({ ...candidate, manifest: parseFollowManifest(value) });
  }
  return files;
}

// --- writes -------------------------------------------------------------------------------------

export type FileChange = { path: string; text: string };

async function ghJson(
  method: "GET" | "POST" | "PATCH",
  path: string,
  body: unknown,
  token: string
): Promise<unknown> {
  const args = ["api", "--method", method, path];
  const options = { env: githubEnvironment(token), timeoutMs: 60_000, maxBuffer: 16 * 1024 * 1024 };
  if (body === undefined) {
    return JSON.parse((await runCommand("gh", args, options)).toString("utf8")) as unknown;
  }
  return JSON.parse(
    (
      await runCommand("gh", [...args, "--input", "-"], { ...options, input: JSON.stringify(body) })
    ).toString("utf8")
  ) as unknown;
}

/**
 * Writes the given files as one commit on `branch`, on top of its current head. The branch must
 * still be at `expectedHead`, so a concurrent change is never overwritten.
 */
export async function commitFiles(args: {
  repository: string;
  branch: string;
  expectedHead: string;
  changes: readonly FileChange[];
  message: string;
  token: string;
}): Promise<string> {
  const { repository, branch, expectedHead, changes, message, token } = args;
  const head = await ghJson("GET", `repos/${repository}/git/ref/heads/${branch}`, undefined, token);
  if (getJsonString(getObject(head), "sha") !== expectedHead) {
    throw new CliError(
      `Branch ${branch} in ${repository} moved; refusing to overwrite a newer head.`,
      65
    );
  }
  const headCommit = await ghJson(
    "GET",
    `repos/${repository}/git/commits/${expectedHead}`,
    undefined,
    token
  );
  const baseTree = getJsonString(getObject(headCommit, "tree"), "sha");

  const entries = [];
  for (const change of changes) {
    const blob = await ghJson(
      "POST",
      `repos/${repository}/git/blobs`,
      { content: change.text, encoding: "utf-8" },
      token
    );
    entries.push({
      path: change.path,
      mode: "100644",
      type: "blob",
      sha: getJsonString(blob, "sha"),
    });
  }
  const tree = await ghJson(
    "POST",
    `repos/${repository}/git/trees`,
    { base_tree: baseTree, tree: entries },
    token
  );
  const commit = await ghJson(
    "POST",
    `repos/${repository}/git/commits`,
    { message, tree: getJsonString(tree, "sha"), parents: [expectedHead] },
    token
  );
  const commitSha = getJsonString(commit, "sha");
  if (!shaPattern.test(commitSha)) {
    throw new CliError(`GitHub did not return a commit for ${repository}.`, 65);
  }
  await ghJson(
    "PATCH",
    `repos/${repository}/git/refs/heads/${branch}`,
    { sha: commitSha, force: false },
    token
  );
  return commitSha;
}

function getObject(value: unknown, key = "object"): unknown {
  return isJsonRecord(value) ? value[key] : undefined;
}

/** Opens a pull request from `branch` unless an open one already exists; returns its number. */
export async function openOrFindPullRequest(args: {
  repository: string;
  branch: string;
  base: string;
  title: string;
  body: string;
  token: string;
}): Promise<number> {
  const owner = args.repository.split("/")[0];
  const existing = await ghJson(
    "GET",
    `repos/${args.repository}/pulls?state=open&head=${owner}:${args.branch}`,
    undefined,
    args.token
  );
  const found = Array.isArray(existing) ? existing.find(isJsonRecord) : undefined;
  if (found && typeof found.number === "number") return found.number;
  const created = await ghJson(
    "POST",
    `repos/${args.repository}/pulls`,
    { title: args.title, head: args.branch, base: args.base, body: args.body },
    args.token
  );
  if (!isJsonRecord(created) || typeof created.number !== "number") {
    throw new CliError(`GitHub did not return a pull request for ${args.repository}.`, 65);
  }
  return created.number;
}
