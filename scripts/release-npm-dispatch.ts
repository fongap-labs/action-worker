import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getGithubJson,
  getJsonArray,
  getJsonString,
  isJsonRecord,
  runGithubCli,
} from "./github-api.ts";
import { publishNpmBeforeTag } from "./release-npm-gate.ts";
import { appendLines, CliError, handleError, isMain, parseJson } from "./runtime-command.ts";

const sourceRepository = "fongap-labs/dsh-plugin";
const controlRepository = "fongap-labs/action-worker";
const workflowFile = "release-npm-auto.yml";
const stableVersionPattern = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

type NpmDispatchRequest = {
  correlation_id: string;
  source_repository: string;
  target_repository: string;
  release_id: string;
  release_key: string;
  version: string;
  tag: string;
  asset_name: string;
  sha256: string;
};

export function validateNpmDispatch(value: unknown): NpmDispatchRequest {
  if (!isJsonRecord(value)) {
    throw new CliError("::error::npm dispatch must contain a verified release request.", 64);
  }
  const request = Object.fromEntries(
    [
      "correlation_id",
      "source_repository",
      "target_repository",
      "release_id",
      "release_key",
      "version",
      "tag",
      "asset_name",
      "sha256",
    ].map((key) => [key, getJsonString(value, key)])
  ) as NpmDispatchRequest;
  if (
    request.source_repository !== sourceRepository ||
    request.target_repository !== sourceRepository ||
    !/^[1-9][0-9]*$/.test(request.release_id) ||
    !/^[1-9][0-9]*-[1-9][0-9]*-[1-9][0-9]*$/.test(request.correlation_id) ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(request.release_key) ||
    !stableVersionPattern.test(request.version) ||
    request.tag !== `${request.release_key}-v${request.version}` ||
    request.asset_name !== `fongap-labs-${request.release_key}.tgz` ||
    !/^[0-9a-f]{64}$/.test(request.sha256)
  ) {
    throw new CliError("::error::Only verified stable dsh-plugin npm releases are allowed.", 66);
  }
  return request;
}

export async function dispatchAndWaitForNpm(options: {
  releaseId: string;
  releaseKey: string;
  version: string;
  tag: string;
  assetName: string;
  sha256: string;
  token: string;
  runId: string;
  attempt: string;
}): Promise<void> {
  const request = validateNpmDispatch({
    correlation_id: `${options.runId}-${options.attempt}-${options.releaseId}`,
    source_repository: sourceRepository,
    target_repository: sourceRepository,
    release_id: options.releaseId,
    release_key: options.releaseKey,
    version: options.version,
    tag: options.tag,
    asset_name: options.assetName,
    sha256: options.sha256,
  });
  if (!options.token) {
    throw new CliError("::error::Scoped npm dispatch token is required.", 77);
  }
  const params = Object.entries(request).flatMap(([key, value]) => [
    "-f",
    `client_payload[${key}]=${value}`,
  ]);
  await runGithubCli(
    [
      "api",
      "--method",
      "POST",
      `repos/${controlRepository}/dispatches`,
      "-f",
      "event_type=run-npm-release",
      ...params,
    ],
    options.token
  );
  const runTitle = `npm-release-${request.correlation_id}`;
  let matchedRunId = 0;
  for (let check = 0; check < 75; check += 1) {
    await new Promise((resolve) => setTimeout(resolve, 8_000));
    const runs = getJsonArray(
      await getGithubJson(
        `repos/${controlRepository}/actions/workflows/${workflowFile}/runs?event=repository_dispatch&per_page=60`,
        options.token
      ),
      "workflow_runs"
    );
    const run = runs.find(
      (value) => isJsonRecord(value) && getJsonString(value, "display_title") === runTitle
    );
    if (!isJsonRecord(run)) continue;
    const runId = run.id;
    if (typeof runId !== "number" || !Number.isSafeInteger(runId)) {
      throw new CliError("::error::npm workflow returned an invalid run id.", 65);
    }
    matchedRunId = runId;
    if (getJsonString(run, "status") !== "completed") continue;
    if (getJsonString(run, "conclusion") !== "success") {
      throw new CliError(
        `::error::Automated npm workflow failed: https://github.com/${controlRepository}/actions/runs/${runId}`,
        65
      );
    }
    // A skipped job also produces a completed run; require the publishing job to succeed.
    const jobs = getJsonArray(
      await getGithubJson(
        `repos/${controlRepository}/actions/runs/${runId}/jobs?per_page=100`,
        options.token
      ),
      "jobs"
    );
    const published = jobs.some(
      (job) =>
        isJsonRecord(job) &&
        getJsonString(job, "name").includes("Verified stable npm publication") &&
        getJsonString(job, "conclusion") === "success"
    );
    if (!published) {
      throw new CliError("::error::npm publishing job was skipped or did not succeed.", 65);
    }
    await appendLines(process.env.GITHUB_STEP_SUMMARY, [
      "## Automatic npm publication",
      "",
      `- Verified job: https://github.com/${controlRepository}/actions/runs/${runId}`,
      `- Package: @fongap-labs/${request.release_key}@${request.version}`,
    ]);
    return;
  }
  throw new CliError(
    `::error::npm publishing did not complete before the release gate deadline (run id: ${matchedRunId || "not visible"}); formal tag withheld.`,
    75
  );
}

export async function consumeNpmDispatch(
  requestValue: unknown,
  token: string,
  npmToken: string
): Promise<void> {
  const request = validateNpmDispatch(requestValue);
  if (!token || !npmToken) {
    throw new CliError("::error::Scoped read token and AW_NPM_TOKEN are required.", 77);
  }
  const release = await getGithubJson(
    `repos/${sourceRepository}/releases/${request.release_id}`,
    token
  );
  if (
    !isJsonRecord(release) ||
    release.draft !== true ||
    release.prerelease !== false ||
    getJsonString(release, "tag_name") !== request.tag ||
    !/^[0-9a-f]{40}$/.test(getJsonString(release, "target_commitish"))
  ) {
    throw new CliError(
      "::error::npm dispatch must reference a valid unpublished stable GitHub Draft Release.",
      66
    );
  }
  const body = getJsonString(release, "body");
  if (
    !/^Source: https:\/\/github\.com\/fongap-labs\/dsh-plugin\/commit\/[0-9a-f]{40}$/m.test(body) ||
    !/^Central CI Evidence: success$/m.test(body) ||
    !/^Main Write Guard: success via PR #[1-9][0-9]*$/m.test(body)
  ) {
    throw new CliError("::error::npm Draft Release provenance is incomplete.", 66);
  }
  const assets = getJsonArray(release, "assets").filter(isJsonRecord);
  const tarball = assets.filter(
    (item) => item.state === "uploaded" && getJsonString(item, "name") === request.asset_name
  );
  const checksum = assets.filter(
    (item) =>
      item.state === "uploaded" && getJsonString(item, "name") === `${request.asset_name}.sha256`
  );
  if (
    tarball.length !== 1 ||
    checksum.length !== 1 ||
    getJsonString(tarball[0], "digest") !== `sha256:${request.sha256}`
  ) {
    throw new CliError(
      "::error::Draft Release tarball or its SHA256 asset is missing or mismatched.",
      66
    );
  }
  const directory = await mkdtemp(join(tmpdir(), "aw-automatic-npm-"));
  try {
    await runGithubCli(
      ["release", "download", request.tag, "--repo", sourceRepository, "--dir", directory],
      token
    );
    const tarballPath = join(directory, request.asset_name);
    const data = await readFile(tarballPath);
    const digest = createHash("sha256").update(data).digest("hex");
    const checksumText = (
      await readFile(join(directory, `${request.asset_name}.sha256`), "utf8")
    ).trim();
    if (digest !== request.sha256 || checksumText !== `${request.sha256}  ${request.asset_name}`) {
      throw new CliError(
        "::error::Downloaded npm package checksum does not match Draft Release.",
        66
      );
    }
    await publishNpmBeforeTag({
      tarballPath,
      workDir: directory,
      releaseKey: request.release_key,
      version: request.version,
      token: npmToken,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (isMain(import.meta.url)) {
  if (process.argv[2] !== "consume") {
    handleError(new CliError("::error::Automatic npm workflow accepts only the consume mode.", 64));
  } else {
    consumeNpmDispatch(
      parseJson(process.env.RELEASE_REQUEST_JSON ?? "", "npm dispatch payload is required.", 64),
      process.env.AW_CONTROL_TOKEN ?? "",
      process.env.AW_NPM_TOKEN ?? ""
    ).catch(handleError);
  }
}
