import { createHash } from "node:crypto";
import { getJsonArray, getJsonString, isJsonRecord } from "./github-api.ts";
import { CliError } from "./runtime-command.ts";

type ReleaseAsset = {
  name: string;
  sha256: string;
};

export type PublishedReleaseReplay = {
  repository: string;
  tag: string;
  sourceRepository: string;
  sourceSha: string;
  artifactRepository: string;
  artifactRunId: number;
  requestId: string;
  isPrerelease: boolean;
  sourceBranch?: "dev";
  assets: readonly ReleaseAsset[];
};

function conflict(tag: string): never {
  throw new CliError(
    `::error::Existing tag or Release conflicts with the verified request: ${tag}. Manual reconciliation is required; no assets or tags were changed.`,
    65
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

// Called only AFTER the new request's signed CI, Main Write Guard, provenance and
// downloaded artifact have passed validation. This is read-only and must never
// treat a bare tag, a draft or an unverified release as a successful replay.
export function assertMatchingPublishedRelease(
  ref: unknown,
  release: unknown,
  request: PublishedReleaseReplay
): void {
  if (!isJsonRecord(ref) || !isJsonRecord(release)) conflict(request.tag);
  const tagObject = ref.object;
  const releaseSha = getJsonString(release, "target_commitish");
  if (
    getJsonString(ref, "ref") !== `refs/tags/${request.tag}` ||
    !isJsonRecord(tagObject) ||
    getJsonString(tagObject, "type") !== "commit" ||
    !/^[0-9a-f]{40}$/.test(releaseSha) ||
    getJsonString(tagObject, "sha") !== releaseSha ||
    (request.sourceBranch === "dev" && releaseSha !== request.sourceSha) ||
    getJsonString(release, "tag_name") !== request.tag ||
    release.draft !== false ||
    release.prerelease !== request.isPrerelease ||
    !getJsonString(release, "published_at") ||
    getJsonString(release, "html_url") !==
      `https://github.com/${request.repository}/releases/tag/${request.tag}`
  ) {
    conflict(request.tag);
  }

  const body = getJsonString(release, "body").split(/\r?\n/);
  const requiredProvenance = [
    `Source: https://github.com/${request.sourceRepository}/commit/${request.sourceSha}`,
    `Artifact run: https://github.com/${request.artifactRepository}/actions/runs/${request.artifactRunId}`,
    `Request: ${request.requestId}`,
    request.sourceBranch === "dev" ? "Dev CI Evidence: success" : "Central CI Evidence: success",
  ];
  if (
    requiredProvenance.some((line) => !body.includes(line)) ||
    !body.some((line) =>
      (request.sourceBranch === "dev"
        ? /^Dev Write Guard: success via PR #[1-9][0-9]*$/
        : /^Main Write Guard: success via PR #[1-9][0-9]*$/
      ).test(line)
    )
  ) {
    conflict(request.tag);
  }

  const expectedDigests = new Map<string, string>();
  for (const asset of request.assets) {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(asset.name) ||
      !/^[0-9a-f]{64}$/.test(asset.sha256) ||
      expectedDigests.has(asset.name) ||
      expectedDigests.has(`${asset.name}.sha256`)
    ) {
      conflict(request.tag);
    }
    expectedDigests.set(asset.name, asset.sha256);
    expectedDigests.set(`${asset.name}.sha256`, sha256(`${asset.sha256}  ${asset.name}\n`));
  }

  let publishedAssets: unknown[];
  try {
    publishedAssets = getJsonArray(release, "assets");
  } catch {
    conflict(request.tag);
  }
  if (publishedAssets.length !== expectedDigests.size) conflict(request.tag);
  const seen = new Set<string>();
  for (const asset of publishedAssets) {
    if (!isJsonRecord(asset)) conflict(request.tag);
    const name = getJsonString(asset, "name");
    if (
      seen.has(name) ||
      !expectedDigests.has(name) ||
      getJsonString(asset, "state") !== "uploaded" ||
      getJsonString(asset, "digest") !== `sha256:${expectedDigests.get(name)}`
    ) {
      conflict(request.tag);
    }
    seen.add(name);
  }
}
