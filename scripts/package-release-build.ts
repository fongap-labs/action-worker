import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CliError,
  handleError,
  isMain,
  readJson,
} from "./runtime-command.ts";
import { parseReleaseBuildPolicy } from "./validate-release-build-request.ts";

async function sha256File(path: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const input = createReadStream(path);
    input.on("error", reject);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("end", () => resolve(hash.digest("hex")));
  });
}

async function main(): Promise<void> {
  const [policyPath = "", sourceRepository = "", sourceSha = "", version = "", artifactDir = ""] = process.argv.slice(2);
  if (!policyPath
    || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(sourceRepository)
    || !/^[0-9a-f]{40}$/.test(sourceSha)
    || !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version)
    || !artifactDir
  ) {
    throw new CliError("Usage: package-release-build.ts <policy> <source-repository> <source-sha> <version> <artifact-dir>", 64);
  }

  const policy = parseReleaseBuildPolicy(await readJson(policyPath));
  const entry = policy.repositories[sourceRepository];
  if (!entry) {
    throw new CliError(`Repository has no release build policy: ${sourceRepository}.`, 65);
  }

  const expected = [
    ...entry.builds.flatMap((build) => build.assets),
    ...(entry.sbom_asset ? [entry.sbom_asset] : []),
  ].sort();
  const actual = (await readdir(artifactDir, { withFileTypes: true }))
    .filter((item) => item.isFile())
    .map((item) => item.name)
    .sort();
  if (actual.length !== expected.length || actual.some((item, index) => item !== expected[index])) {
    throw new CliError(
      `Release build assets do not match policy: expected=${expected.join(",")} actual=${actual.join(",")}.`,
      66,
    );
  }

  const assets = [];
  for (const name of expected) {
    assets.push({ name, sha256: await sha256File(join(artifactDir, name)) });
  }

  const artifactRepository = process.env.GITHUB_REPOSITORY ?? "";
  const artifactRunId = Number(process.env.GITHUB_RUN_ID ?? "");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(artifactRepository)
    || !Number.isInteger(artifactRunId) || artifactRunId < 1
  ) {
    throw new CliError("Release artifact runtime identity is invalid.", 77);
  }

  const manifest = {
    schema_version: "1",
    target_repository: entry.target_repository,
    release_key: entry.release_key,
    version,
    release_name: `${entry.release_name} ${version}`,
    release_notes: entry.release_notes,
    prerelease: false,
    license: { expression: entry.license_expression },
    assets,
  };
  const provenance = {
    schema_version: "1",
    source_repository: sourceRepository,
    source_sha: sourceSha,
    artifact_repository: artifactRepository,
    artifact_run_id: artifactRunId,
  };

  await writeFile(join(artifactDir, "release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await writeFile(join(artifactDir, "release-provenance.json"), `${JSON.stringify(provenance, null, 2)}\n`, "utf8");
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
