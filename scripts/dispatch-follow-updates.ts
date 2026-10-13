import {
  commitFiles,
  type FileChange,
  type FollowFile,
  isPublishedRelease,
  type JsonReader,
  listFollowFiles,
  openOrFindPullRequest,
  readFileAt,
  resolveTagCommit,
} from "./follow-github.ts";
import { editPinFile, type FollowManifest, groupPinEdits, type PinValue } from "./follow-pins.ts";
import {
  GithubHttpError,
  GithubReader,
  getJsonString,
  githubEnvironment,
  isJsonRecord,
} from "./github-api.ts";
import { buildTag } from "./publish-release.ts";
import { hasRepositoryCapability, repositoriesForCapability } from "./repository-policy.ts";
import {
  appendLines,
  CliError,
  handleError,
  isMain,
  parseJson,
  runCommand,
} from "./runtime-command.ts";

// Runs after a governed release: every managed follower whose follows.json names the released
// upstream gets its pins moved to the released tag, as one commit on aw/follow/<product>, and a pull
// request for that branch. Only the pin files change here; a uv.lock is refreshed by a later job.

export type FollowRelease = {
  repository: string;
  release_key: string;
  version: string;
  tag: string;
  commit: string;
};

export type FollowResult = {
  repository: string;
  product: string;
  // An artifact-safe name for this follower, unique per repository and product.
  slug: string;
  branch: string;
  head_sha: string;
  is_private: boolean;
  project_dir: string;
  lockfile: string;
  pull_request: number;
};

const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const releaseKeyPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function followBranchName(repository: string, product: string): string {
  const name = product === "" ? repository.split("/")[1] : product;
  return `aw/follow/${name}`;
}

export function pinValueFor(kind: PinValue, release: FollowRelease): string {
  return kind === "commit" ? release.commit : release.version;
}

/**
 * The file changes that move every pin of a follower to the release. A pin already at its value
 * produces no change, and a file that would not change is not returned.
 */
export function planFollowChanges(
  manifest: FollowManifest,
  texts: ReadonlyMap<string, string>,
  release: FollowRelease
): FileChange[] {
  const groups = groupPinEdits(manifest.pins, (pin) => pinValueFor(pin.value, release));
  const changes: FileChange[] = [];
  for (const [path, edits] of groups) {
    const text = texts.get(path);
    if (text === undefined) {
      throw new CliError(`Follow pin file is missing at the branch head: ${path}.`, 65);
    }
    const next = editPinFile(path, text, edits);
    if (next !== text) changes.push({ path, text: next });
  }
  return changes;
}

export function followProjectDirectory(product: string): string {
  return product === "" ? "" : `projects/${product}`;
}

async function readTexts(
  reader: JsonReader,
  repository: string,
  manifest: FollowManifest,
  sha: string
): Promise<Map<string, string>> {
  const texts = new Map<string, string>();
  for (const pin of manifest.pins) {
    if (texts.has(pin.path)) continue;
    const text = await readFileAt(reader, repository, pin.path, sha);
    if (text === null) {
      throw new CliError(`Follow pin file is missing in ${repository}: ${pin.path}.`, 65);
    }
    texts.set(pin.path, text);
  }
  return texts;
}

async function dispatchFollower(args: {
  reader: GithubReader;
  token: string;
  release: FollowRelease;
  follower: FollowFile;
  repository: string;
  defaultBranch: string;
  defaultSha: string;
  isPrivate: boolean;
}): Promise<FollowResult | null> {
  const { reader, token, release, follower, repository, defaultBranch, defaultSha } = args;
  const branch = followBranchName(repository, follower.product);
  const branchRef = await readBranchHead(reader, repository, branch);
  const base = branchRef ?? defaultSha;

  const texts = await readTexts(reader, repository, follower.manifest, base);
  const changes = planFollowChanges(follower.manifest, texts, release);
  if (changes.length === 0) {
    console.log(
      `Follow up to date: ${repository} ${follower.product || "(root)"} is pinned to ${release.tag}.`
    );
    return null;
  }

  if (branchRef === null) {
    await runCommand(
      "gh",
      ["api", "--method", "POST", `repos/${repository}/git/refs`, "--input", "-"],
      {
        env: githubEnvironment(token),
        input: JSON.stringify({ ref: `refs/heads/${branch}`, sha: defaultSha }),
        timeoutMs: 60_000,
        maxBuffer: 1024 * 1024,
      }
    );
  }
  const message = `chore(follow): update pins for ${release.release_key} to ${release.version}`;
  const headSha = await commitFiles({
    repository,
    branch,
    expectedHead: base,
    changes,
    message,
    token,
  });
  const pullRequest = await openOrFindPullRequest({
    repository,
    branch,
    base: defaultBranch,
    title: message,
    body: [
      `This pull request moves the pins of ${follower.product || "the root product"} to ${release.tag}.`,
      "",
      `Upstream: ${release.repository} (release key ${release.release_key}, version ${release.version}).`,
      "",
      "Only the declared pin files change. A uv.lock, when the follower declares one, is refreshed on this branch after this commit.",
    ].join("\n"),
    token,
  });

  return {
    repository,
    product: follower.product,
    slug: `${repository.replace("/", "-")}-${follower.product || "root"}`,
    branch,
    head_sha: headSha,
    is_private: args.isPrivate,
    project_dir: followProjectDirectory(follower.product),
    lockfile: follower.manifest.lockfile ?? "",
    pull_request: pullRequest,
  };
}

async function readBranchHead(
  reader: GithubReader,
  repository: string,
  branch: string
): Promise<string | null> {
  try {
    const ref = await reader.get(`repos/${repository}/git/ref/heads/${branch}`);
    const object = isJsonRecord(ref) ? ref.object : undefined;
    return getJsonString(object, "sha") || null;
  } catch (error) {
    if (error instanceof GithubHttpError && error.status === 404) return null;
    throw error;
  }
}

async function main(): Promise<void> {
  const policyRaw = process.env.AW_REPOSITORY_POLICY ?? "";
  const token = process.env.AW_CONTROL_TOKEN ?? "";
  const controlRepository = process.env.AW_CONTROL_REPOSITORY ?? "";
  const upstream = process.env.FOLLOW_UPSTREAM_REPOSITORY ?? "";
  const releaseKey = process.env.FOLLOW_RELEASE_KEY ?? "";
  const version = process.env.FOLLOW_RELEASE_VERSION ?? "";
  const tag = process.env.FOLLOW_RELEASE_TAG ?? "";
  if (!policyRaw || !token || !repositoryPattern.test(controlRepository)) {
    throw new CliError(
      "AW_REPOSITORY_POLICY, AW_CONTROL_TOKEN and AW_CONTROL_REPOSITORY are required.",
      64
    );
  }
  if (
    !repositoryPattern.test(upstream) ||
    !releaseKeyPattern.test(releaseKey) ||
    !semverPattern.test(version)
  ) {
    throw new CliError("Follow release identity is invalid.", 64);
  }
  if (tag !== buildTag(releaseKey, version)) {
    throw new CliError(
      `Follow release tag does not match the release key and version: ${tag}.`,
      64
    );
  }
  const policy = parseJson(policyRaw, "AW_REPOSITORY_POLICY must be valid JSON.", 65);
  if (!hasRepositoryCapability(upstream, policy, "release-target")) {
    throw new CliError(`Upstream repository is not a managed release target: ${upstream}.`, 77);
  }

  const reader = new GithubReader(process.env.GITHUB_API_URL ?? "https://api.github.com", token);
  const commit = await resolveTagCommit(reader, upstream, tag);
  if (commit === null) {
    throw new CliError(`Release tag does not exist in ${upstream}: ${tag}.`, 65);
  }
  if (!(await isPublishedRelease(reader, upstream, tag))) {
    throw new CliError(`Release is not published in ${upstream}: ${tag}.`, 65);
  }
  const release: FollowRelease = {
    repository: upstream,
    release_key: releaseKey,
    version,
    tag,
    commit,
  };

  const followers: FollowResult[] = [];
  const repositories = repositoriesForCapability(policy, "pr").filter(
    (repository) => repository !== upstream && repository !== controlRepository
  );
  for (const repository of repositories) {
    const info = await reader.get(`repos/${repository}`);
    const defaultBranch = getJsonString(info, "default_branch");
    const isPrivate = isJsonRecord(info) && info.private === true;
    const head = await reader.get(`repos/${repository}/commits/${defaultBranch}`);
    const defaultSha = getJsonString(head, "sha");
    for (const follower of await listFollowFiles(reader, repository, defaultSha)) {
      const declared = follower.manifest.upstream;
      if (declared.repository !== upstream || declared.release_key !== releaseKey) continue;
      const result = await dispatchFollower({
        reader,
        token,
        release,
        follower,
        repository,
        defaultBranch,
        defaultSha,
        isPrivate,
      });
      if (result !== null) followers.push(result);
    }
  }

  const lockFollowers = followers.filter((item) => item.lockfile === "uv");
  await appendLines(process.env.GITHUB_OUTPUT, [
    `followers=${JSON.stringify(followers)}`,
    `lock_followers=${JSON.stringify(lockFollowers)}`,
  ]);
  await appendLines(process.env.GITHUB_STEP_SUMMARY, [
    "## Follow updates",
    "",
    `- Upstream: ${upstream} ${tag}`,
    `- Followers updated: ${followers.length}`,
    ...followers.map(
      (item) =>
        `- ${item.repository} ${item.product || "(root)"}: ${item.branch}@${item.head_sha.slice(0, 12)} (PR #${item.pull_request})`
    ),
  ]);
  console.log(JSON.stringify({ upstream, tag, followers: followers.length }));
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
