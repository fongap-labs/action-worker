import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  parseReleaseBuildManifest,
  type ReleaseBuildManifest,
} from "./validate-release-build-request.ts";
import { CliError, handleError, isMain, readJson } from "./runtime-command.ts";

const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const shaPattern = /^[0-9a-f]{40}$/;

export type RequiredAttestation = { asset: string; build: string };
/** A legacy beta may opt out; formal releases must have evidence for every build asset. */
export function requiredAttestations(
  manifest: ReleaseBuildManifest,
  version: string
): RequiredAttestation[] {
  const result: RequiredAttestation[] = [];
  for (const build of manifest.builds) {
    if (!build.attest_asset) {
      if (!version.includes("-beta.")) {
        throw new CliError(
          `Formal release build ${build.id} does not declare attestation; fill attest_asset.`,
          66
        );
      }
      continue;
    }
    for (const asset of build.assets) result.push({ asset, build: build.id });
  }
  return result;
}

export function verifyArguments(
  file: string,
  signerRepository: string,
  controlSha: string
): string[] {
  if (!repositoryPattern.test(signerRepository) || !shaPattern.test(controlSha)) {
    throw new CliError("Release attestation signer repository or source SHA is invalid.", 65);
  }
  return [
    "attestation",
    "verify",
    file,
    "--repo",
    signerRepository,
    "--signer-workflow",
    `${signerRepository}/.github/workflows/release-app.yml`,
    "--source-digest",
    controlSha,
    "--format",
    "json",
  ];
}

export function hasVerifiedAsset(result: unknown, name: string, digest: string): boolean {
  if (!Array.isArray(result)) return false;
  return result.some((item: unknown) => {
    if (typeof item !== "object" || item === null || !("verificationResult" in item)) {
      return false;
    }
    const statement = (item as { verificationResult?: { statement?: { subject?: unknown } } })
      .verificationResult?.statement;
    return (
      Array.isArray(statement?.subject) &&
      statement.subject.some(
        (subject: unknown) =>
          typeof subject === "object" &&
          subject !== null &&
          "name" in subject &&
          "digest" in subject &&
          subject.name === name &&
          typeof subject.digest === "object" &&
          subject.digest !== null &&
          "sha256" in subject.digest &&
          subject.digest.sha256 === digest
      )
    );
  });
}

async function main(): Promise<void> {
  const [manifestFile, artifactDir, version] = process.argv.slice(2);
  const signerRepository = process.env.GITHUB_REPOSITORY ?? "";
  const controlSha = process.env.GITHUB_SHA ?? "";
  if (!manifestFile || !artifactDir || !version) {
    throw new CliError(
      "Usage: verify-release-attestations.ts <manifest> <artifact-dir> <version>",
      64
    );
  }
  assert.match(version, /^\d+\.\d+\.\d+(?:-beta\.[1-9]\d*)?$/);
  const manifest = parseReleaseBuildManifest(await readJson(manifestFile));
  const needs = requiredAttestations(manifest, version);
  for (const requirement of needs) {
    const file = join(artifactDir, requirement.asset);
    const bytes = await readFile(file);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const argv = verifyArguments(file, signerRepository, controlSha);
    const processResult = spawnSync("gh", argv, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
      maxBuffer: 8 * 1024 * 1024,
    });
    if (processResult.error || processResult.status !== 0) {
      throw new CliError(
        `Release attestation verification failed for ${requirement.asset}: ${processResult.error?.message ?? processResult.stderr?.slice(0, 500)}`,
        66
      );
    }
    let evidence: unknown;
    try {
      evidence = JSON.parse(processResult.stdout);
    } catch {
      throw new CliError(`Attestation CLI returned invalid JSON for ${requirement.asset}.`, 66);
    }
    if (!hasVerifiedAsset(evidence, requirement.asset, digest)) {
      throw new CliError(
        `Verified attestation does not match ${requirement.asset} SHA256 digest.`,
        66
      );
    }
    console.log(`Verified release provenance: ${requirement.build} / ${requirement.asset}`);
  }
  console.log(`Verified ${needs.length} release asset attestations.`);
}

if (isMain(import.meta.url)) main().catch(handleError);
