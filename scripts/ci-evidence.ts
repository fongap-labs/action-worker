import {
  getJsonArray,
  getJsonString,
  isJsonRecord,
  type JsonRecord,
} from "./github-api.ts";

const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function trustedControlRunId(
  targetUrl: string,
  controlRepository: string,
): number | null {
  if (!repositoryPattern.test(controlRepository)) return null;
  const prefix = `https://github.com/${controlRepository}/actions/runs/`;
  if (!targetUrl.startsWith(prefix)) return null;
  const suffix = targetUrl.slice(prefix.length);
  if (!/^\d+$/.test(suffix)) return null;
  const runId = Number(suffix);
  return Number.isSafeInteger(runId) && runId > 0 ? runId : null;
}

export function latestCiStatus(
  response: unknown,
  context: string,
): JsonRecord | undefined {
  return getJsonArray(response, "statuses")
    .filter(isJsonRecord)
    .find((item) => getJsonString(item, "context") === context);
}

export function trustedCiStatus(
  response: unknown,
  context: string,
  controlRepository: string,
): JsonRecord | undefined {
  const status = latestCiStatus(response, context);
  if (!status) return undefined;
  const targetUrl = getJsonString(status, "target_url");
  return trustedControlRunId(targetUrl, controlRepository) ? status : undefined;
}

export function hasTrustedSuccessfulCiEvidence(
  response: unknown,
  context: string,
  controlRepository: string,
): boolean {
  return getJsonString(
    trustedCiStatus(response, context, controlRepository),
    "state",
  ) === "success";
}
