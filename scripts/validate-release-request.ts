import { isJsonRecord } from "./github-api.ts";
import {
  CliError,
  handleError,
  isMain,
  parseJson,
  readJson,
} from "./runtime-command.ts";

const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const requestPattern = /^[A-Za-z0-9._:-]{1,128}$/;
const assetPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const versionPattern = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function isExactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(value);
  return required.every((key) => keys.includes(key))
    && keys.every((key) => required.includes(key) || optional.includes(key));
}

function repositoryList(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && repositoryPattern.test(item))) {
    throw new CliError(`${name} must be a JSON array of repositories.`, 65);
  }
  return value;
}

export function validateRelease(
  request: unknown,
  manifest: unknown | undefined,
  sourceValue: unknown,
  targetValue: unknown,
): void {
  const sourceList = repositoryList(sourceValue, "RELEASE_SOURCE_ALLOWLIST");
  const targetList = repositoryList(targetValue, "RELEASE_TARGET_ALLOWLIST");
  if (!isJsonRecord(request)
    || !isExactKeys(request, ["artifact_name", "repository", "request_id", "schema_version", "source_run_id", "source_sha"])
    || request.schema_version !== "1"
    || typeof request.request_id !== "string" || !requestPattern.test(request.request_id)
    || typeof request.repository !== "string" || !repositoryPattern.test(request.repository)
    || typeof request.source_sha !== "string" || !/^[0-9a-f]{40}$/.test(request.source_sha)
    || typeof request.source_run_id !== "number" || !Number.isInteger(request.source_run_id) || request.source_run_id < 1
    || typeof request.artifact_name !== "string" || request.artifact_name.length > 128 || !/^[A-Za-z0-9._-]+$/.test(request.artifact_name)
  ) {
    throw new CliError("release dispatch payload is invalid.", 64);
  }
  if (!sourceList.includes(request.repository)) {
    throw new CliError(`source repository is not allowed for release dispatch: ${request.repository}`, 77);
  }
  if (manifest === undefined) {
    return;
  }
  const requiredKeys = ["schema_version", "target_repository", "release_key", "version", "assets"];
  const optionalKeys = ["release_name", "release_notes", "prerelease", "license"];
  if (!isJsonRecord(manifest)
    || !isExactKeys(manifest, requiredKeys, optionalKeys)
    || manifest.schema_version !== "1"
    || typeof manifest.target_repository !== "string" || !repositoryPattern.test(manifest.target_repository)
    || typeof manifest.release_key !== "string" || manifest.release_key.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(manifest.release_key)
    || typeof manifest.version !== "string" || !versionPattern.test(manifest.version)
    || (manifest.release_name !== undefined && (typeof manifest.release_name !== "string" || manifest.release_name.length > 160))
    || (manifest.release_notes !== undefined && (typeof manifest.release_notes !== "string" || manifest.release_notes.length > 20_000))
    || (manifest.prerelease !== undefined && typeof manifest.prerelease !== "boolean")
    || !Array.isArray(manifest.assets) || manifest.assets.length < 1 || manifest.assets.length > 50
  ) {
    throw new CliError("release manifest is invalid.", 64);
  }
  const assetNames: string[] = [];
  for (const item of manifest.assets) {
    if (!isJsonRecord(item)
      || !isExactKeys(item, ["name", "sha256"])
      || typeof item.name !== "string" || item.name.length > 160 || !assetPattern.test(item.name)
      || typeof item.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(item.sha256)
    ) {
      throw new CliError("release manifest is invalid.", 64);
    }
    assetNames.push(item.name);
  }
  if (new Set(assetNames).size !== assetNames.length) {
    throw new CliError("release manifest is invalid.", 64);
  }
  if (manifest.license !== undefined) {
    const license = manifest.license;
    if (!isJsonRecord(license)
      || !isExactKeys(license, ["expression"], ["file"])
      || typeof license.expression !== "string" || license.expression.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9.+() -]*$/.test(license.expression)
      || (license.file !== undefined && (typeof license.file !== "string" || license.file.length > 160 || !assetPattern.test(license.file)))
      || (typeof license.file === "string" && !assetNames.includes(license.file))
    ) {
      throw new CliError("release manifest is invalid.", 64);
    }
  }
  if (!targetList.includes(manifest.target_repository)) {
    throw new CliError(`target repository is not allowed for release publication: ${manifest.target_repository}`, 77);
  }
}

async function main(): Promise<void> {
  const requestPath = process.argv[2] ?? "";
  const manifestPath = process.argv[3];
  if (!requestPath) {
    throw new CliError("release request file is required.", 64);
  }
  let request: unknown;
  try {
    request = await readJson(requestPath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new CliError("release request file is required.", 64);
    }
    throw error;
  }
  let manifest: unknown | undefined;
  if (manifestPath) {
    try {
      manifest = await readJson(manifestPath);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        throw new CliError(`release manifest not found: ${manifestPath}`, 66);
      }
      throw error;
    }
  }
  validateRelease(
    request,
    manifest,
    parseJson(process.env.RELEASE_SOURCE_ALLOWLIST ?? "[]", "RELEASE_SOURCE_ALLOWLIST must be valid JSON."),
    parseJson(process.env.RELEASE_TARGET_ALLOWLIST ?? "[]", "RELEASE_TARGET_ALLOWLIST must be valid JSON."),
  );
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
