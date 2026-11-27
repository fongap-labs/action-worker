import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { isClosedDevProtection } from "./dev-bootstrap-authorization.ts";
import {
  GithubReader,
  getGithubJsonIfExists,
  getJsonNumber,
  getJsonString,
  isJsonRecord,
} from "./github-api.ts";
import { CliError } from "./runtime-command.ts";

type Reader = { get(path: string): Promise<unknown> };
type Writer = (method: "POST" | "PUT" | "DELETE", path: string, body?: unknown) => Promise<unknown>;
export const temporaryDevGuardName = "Dev Bootstrap Creation Guard";

export function devRulesetSnapshot(value: unknown) {
  if (!isJsonRecord(value)) throw new CliError("Invalid dev ruleset response.", 75);
  return {
    name: value.name,
    target: value.target,
    enforcement: value.enforcement,
    conditions: value.conditions,
    bypass_actors: value.bypass_actors,
    rules: Array.isArray(value.rules)
      ? value.rules.toSorted((left, right) =>
          getJsonString(left, "type").localeCompare(getJsonString(right, "type"))
        )
      : value.rules,
  };
}

/** Use the same reviewed GitHub App identity already trusted by the main status gate. */
export function bootstrapIntegrationId(): number {
  const policy: unknown = JSON.parse(readFileSync("policies/rulesets.json", "utf8"));
  const main =
    isJsonRecord(policy) && Array.isArray(policy.rulesets)
      ? policy.rulesets.find((rule) => getJsonString(rule, "name") === "Protect Main Branch")
      : undefined;
  const check =
    isJsonRecord(main) && Array.isArray(main.rules)
      ? main.rules.find((rule) => getJsonString(rule, "type") === "required_status_checks")
      : undefined;
  const checks =
    isJsonRecord(check) && isJsonRecord(check.parameters)
      ? check.parameters.required_status_checks
      : undefined;
  const gate = Array.isArray(checks)
    ? checks.filter((item) => getJsonString(item, "context") === "validate-merge")
    : [];
  const id = getJsonNumber(gate[0], "integration_id");
  if (gate.length !== 1 || !Number.isSafeInteger(id) || id < 1) {
    throw new CliError("Trusted GitHub App identity is missing from the central policy.", 75);
  }
  return id;
}

export async function createProtectedDevBranch(
  reader: Reader,
  admin: Writer,
  createRef: Writer,
  repository: string,
  sha: string,
  integrationId: number
): Promise<void> {
  if (
    !/^fongap-labs\/[A-Za-z0-9_.-]+$/.test(repository) ||
    !/^[0-9a-f]{40}$/.test(sha) ||
    !Number.isSafeInteger(integrationId) ||
    integrationId < 1
  ) {
    throw new CliError("Invalid protected dev creation request.", 65);
  }
  const prefix = `repos/${repository}`;
  const rulesPath = `${prefix}/rulesets`;
  const listPath = `${rulesPath}?includes_parents=false&per_page=100`;
  const detailPath = (id: number) => `${rulesPath}/${id}?includes_parents=false`;
  const branchPath = (branch: string) => `${prefix}/branches/${branch}`;
  const assertSource = async () => {
    const main = await reader.get(branchPath("main"));
    const dev = await getGithubJsonIfExists(branchPath("dev"), (path) => reader.get(path));
    if (!isJsonRecord(main) || getJsonString(main.commit, "sha") !== sha || dev !== undefined) {
      throw new CliError(
        "Locked main SHA changed or dev already exists; no ref write allowed.",
        75
      );
    }
  };

  await assertSource();
  const rules = await reader.get(listPath);
  if (!Array.isArray(rules)) throw new CliError("Managed rulesets unavailable.", 75);
  const closedRules = rules.filter((rule) => getJsonString(rule, "name") === "Protect Dev Branch");
  const id = getJsonNumber(closedRules[0], "id");
  if (
    closedRules.length !== 1 ||
    !Number.isSafeInteger(id) ||
    id < 1 ||
    rules.some((rule) => getJsonString(rule, "name") === temporaryDevGuardName)
  ) {
    throw new CliError("Unexpected or unfinished dev creation protection; inspect rulesets.", 75);
  }
  const original = devRulesetSnapshot(await reader.get(detailPath(id)));
  if (
    !isClosedDevProtection(original) ||
    !Array.isArray(original.rules) ||
    original.rules.length !== 4
  ) {
    throw new CliError("Exact closed dev ruleset is required before initialization.", 75);
  }
  const reduced = {
    ...original,
    rules: original.rules.filter((rule) => getJsonString(rule, "type") !== "creation"),
  };
  // The temporary rule restricts creation to the trusted App, while the existing
  // rule continues to prohibit all updates, deletions and force pushes.
  const guard = {
    name: temporaryDevGuardName,
    target: "branch",
    enforcement: "active",
    conditions: original.conditions,
    bypass_actors: [{ actor_id: integrationId, actor_type: "Integration", bypass_mode: "always" }],
    rules: [{ type: "creation" }],
  };
  let guardId = 0;
  const restoreProtection = async () => {
    if (guardId > 0 && guardId !== id) {
      const current = devRulesetSnapshot(await reader.get(detailPath(id)));
      if (!isDeepStrictEqual(current, original)) {
        if (!isDeepStrictEqual(current, reduced)) {
          throw new CliError("Unexpected dev ruleset drift; creation guard retained.", 75);
        }
        await admin("PUT", `${rulesPath}/${id}`, original);
      }
      if (!isDeepStrictEqual(devRulesetSnapshot(await reader.get(detailPath(id))), original)) {
        throw new CliError("Closed dev protection not restored; creation guard retained.", 75);
      }
      await admin("DELETE", `${rulesPath}/${guardId}`);
    }
  };
  try {
    const created = await admin("POST", rulesPath, guard);
    guardId = getJsonNumber(created, "id");
    if (!Number.isSafeInteger(guardId) || guardId < 1 || guardId === id) {
      throw new CliError("Temporary creation guard ID unavailable; original lock retained.", 75);
    }
    if (!isDeepStrictEqual(devRulesetSnapshot(await reader.get(detailPath(guardId))), guard)) {
      throw new CliError("Temporary creation guard cannot be independently verified.", 75);
    }
    if (!isDeepStrictEqual(devRulesetSnapshot(await reader.get(detailPath(id))), original)) {
      throw new CliError("Dev protection changed concurrently; no ref write allowed.", 75);
    }
    await admin("PUT", `${rulesPath}/${id}`, reduced);
    if (
      !isDeepStrictEqual(devRulesetSnapshot(await reader.get(detailPath(id))), reduced) ||
      !isDeepStrictEqual(devRulesetSnapshot(await reader.get(detailPath(guardId))), guard)
    ) {
      throw new CliError("Scoped creation protection changed; no ref write allowed.", 75);
    }
    await assertSource();
    await createRef("POST", `${prefix}/git/refs`, { ref: "refs/heads/dev", sha });
  } finally {
    await restoreProtection();
  }

  const dev = await reader.get(branchPath("dev"));
  if (
    !isJsonRecord(dev) ||
    getJsonString(dev.commit, "sha") !== sha ||
    !isDeepStrictEqual(devRulesetSnapshot(await reader.get(detailPath(id))), original)
  ) {
    throw new CliError("Dev branch or restored protection verification failed.", 75);
  }
  const finalRules = await reader.get(listPath);
  if (
    !Array.isArray(finalRules) ||
    finalRules.some((rule) => getJsonString(rule, "name") === temporaryDevGuardName)
  ) {
    throw new CliError("Temporary dev creation protection is not cleaned up.", 75);
  }
}

function githubWriter(apiUrl: string, token: string): Writer {
  if (!token) throw new CliError("Required scoped GitHub credential is missing.", 77);
  return async (method, path, body) => {
    const response = await fetch(`${apiUrl.replace(/\/+$/, "")}/${path}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new CliError(
        `GitHub dev initialization ${method} failed (HTTP ${response.status}).`,
        75
      );
    }
    return response.status === 204 ? undefined : await response.json();
  };
}

export async function initializeProtectedDev(
  apiUrl: string,
  adminToken: string,
  refToken: string,
  repository: string,
  sha: string
): Promise<void> {
  const reader = new GithubReader(apiUrl, adminToken);
  await createProtectedDevBranch(
    reader,
    githubWriter(apiUrl, adminToken),
    githubWriter(apiUrl, refToken),
    repository,
    sha,
    bootstrapIntegrationId()
  );
}

export async function deleteTemporaryDevGuard(
  apiUrl: string,
  token: string,
  repository: string,
  id: number
): Promise<void> {
  if (
    !/^fongap-labs\/[A-Za-z0-9_.-]+$/.test(repository) ||
    !Number.isSafeInteger(id) ||
    id < 1
  ) {
    throw new CliError("Invalid development guard cleanup scope.", 65);
  }
  await githubWriter(apiUrl, token)("DELETE", `repos/${repository}/rulesets/${id}`);
}
