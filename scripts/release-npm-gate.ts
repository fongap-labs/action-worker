import { readFile } from "node:fs/promises";
import { configureNpmAuth, npmRegistry, publishNpmTarball } from "./npm-publish.ts";
import {
  ensureDistTag,
  npmPackageIntegrity,
  readPublishedIntegrity,
  validateNpmPackageManifest,
  waitForPublishedIntegrity,
} from "./republish-release-npm.ts";
import { appendLines, CliError, parseJson, runText } from "./runtime-command.ts";

type ReleaseAsset = { name: string; sha256: string };

const npmReleaseRepository = "fongap-labs/dsh-plugin";
const stableVersionPattern = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

/**
 * Only stable DSH plugin releases publish npm packages before their formal tag.
 * Beta/prerelease versions publish verified GitHub Release assets only.
 * Other repositories publish verified downloadable assets, not npm packages.
 */
export function selectPreTagNpmAsset(
  sourceRepository: string,
  targetRepository: string,
  releaseKey: string,
  version: string,
  isPrerelease: boolean,
  assets: readonly ReleaseAsset[]
): ReleaseAsset | null {
  if (targetRepository !== npmReleaseRepository) return null;
  if (sourceRepository !== npmReleaseRepository) {
    throw new CliError("::error::npm release source must be fongap-labs/dsh-plugin.", 66);
  }
  // Beta releases remain GitHub-only even if their assets contain an npm tarball.
  if (isPrerelease || version.includes("-")) return null;
  if (!stableVersionPattern.test(version)) {
    throw new CliError("::error::Stable npm release requires an X.Y.Z version.", 66);
  }
  const tarballs = assets.filter((asset) => asset.name.endsWith(".tgz"));
  if (tarballs.length !== 1 || tarballs[0]?.name !== `fongap-labs-${releaseKey}.tgz`) {
    throw new CliError(
      "::error::DSH plugin Release must contain exactly its named npm tarball.",
      66
    );
  }
  return tarballs[0]!;
}

export async function publishNpmBeforeTag(options: {
  tarballPath: string;
  workDir: string;
  releaseKey: string;
  version: string;
  token: string;
}): Promise<void> {
  const { tarballPath, workDir, releaseKey, version, token } = options;
  // Guard the publishing function itself against accidental direct beta invocation.
  if (!stableVersionPattern.test(version)) {
    throw new CliError("::error::Beta and other prerelease versions must not publish npm.", 66);
  }
  if (!token.trim()) {
    throw new CliError(
      "::error::AW_NPM_TOKEN is required before creating a DSH plugin release tag.",
      77
    );
  }
  const manifest = validateNpmPackageManifest(
    parseJson(
      await runText("tar", ["-xOf", tarballPath, "package/package.json"], {
        maxBuffer: 1024 * 1024,
        timeoutMs: 30_000,
      }),
      "::error::npm tarball contains invalid package.json.",
      66
    ),
    version
  );
  if (manifest.name !== `@fongap-labs/${releaseKey}`) {
    throw new CliError("::error::npm package name does not match the governed release key.", 66);
  }
  const tarball = await readFile(tarballPath);
  const expectedIntegrity = npmPackageIntegrity(tarball);
  const env = await configureNpmAuth(workDir, token);
  let observedIntegrity = await readPublishedIntegrity(manifest.name, version, workDir, env);
  if (observedIntegrity === undefined) {
    await publishNpmTarball(tarballPath, workDir, token, version);
    observedIntegrity = await waitForPublishedIntegrity(manifest.name, version, workDir, env);
  }
  if (observedIntegrity !== expectedIntegrity) {
    throw new CliError(
      "::error::npm registry did not confirm the exact published tarball integrity; Release tag withheld.",
      65
    );
  }
  await ensureDistTag(manifest.name, version, workDir, env);
  const distTag = "latest";
  const tags = parseJson(
    await runText(
      "npm",
      ["view", manifest.name, "dist-tags", "--json", "--registry", npmRegistry],
      {
        cwd: workDir,
        env,
        timeoutMs: 30_000,
      }
    ),
    "::error::npm registry returned invalid dist-tags.",
    65
  );
  if (
    !tags ||
    typeof tags !== "object" ||
    Array.isArray(tags) ||
    (tags as Record<string, unknown>)[distTag] !== version
  ) {
    throw new CliError("::error::npm dist-tag was not confirmed; GitHub Release tag withheld.", 65);
  }
  await appendLines(process.env.GITHUB_STEP_SUMMARY, [
    "## npm publication gate",
    "",
    `- Package: ${manifest.name}@${version}`,
    "- Registry integrity: verified",
    `- dist-tag: ${distTag}`,
    "- GitHub Release tag: pending publication",
  ]);
}
