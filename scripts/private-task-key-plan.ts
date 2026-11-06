import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { appendLines, CliError, handleError, isMain } from "./runtime-command.ts";

const identityPattern = /^fongap-labs\/[A-Za-z0-9_.-]+$/;
const projectPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const fingerprintPattern = /^[a-f0-9]{64}$/;
const maxPolicyBytes = 32 * 1024;

export type ProjectTransferKeyPlan = {
  inbound_public_var: string;
  inbound_private_secret: string;
  outbound_public_var: string;
  outbound_private_secret: string;
  inbound_fingerprint: string;
  outbound_fingerprint: string;
};

function reject(): never {
  // Do not print private repository/project identifiers in public CI.
  throw new CliError("Private transfer key enrollment is missing or invalid.", 77);
}

// The names contain a hash of the exact repository+project pair, not a
// sanitized identifier that could alias two independent projects.
export function privateTaskKeyPrefix(repository: string, project: string): string {
  if (!identityPattern.test(repository) || !projectPattern.test(project)) reject();
  const id = createHash("sha256")
    .update(repository)
    .update("\0")
    .update(project)
    .digest("hex")
    .slice(0, 24)
    .toUpperCase();
  return `AW_PRIVATE_${id}`;
}

export async function resolveProjectTransferKeyPlan(
  repository: string,
  project: string,
  policyPath = "policies/private-task-keys.json"
): Promise<ProjectTransferKeyPlan> {
  const prefix = privateTaskKeyPrefix(repository, project);
  const contents = await readFile(policyPath, "utf8");
  if (Buffer.byteLength(contents, "utf8") > maxPolicyBytes) reject();
  let policy: unknown;
  try {
    policy = JSON.parse(contents) as unknown;
  } catch {
    return reject();
  }
  if (
    typeof policy !== "object" ||
    policy === null ||
    Array.isArray(policy) ||
    Object.keys(policy).sort().join(",") !== "projects,schema_version" ||
    !("schema_version" in policy) ||
    policy.schema_version !== 1 ||
    !("projects" in policy) ||
    typeof policy.projects !== "object" ||
    policy.projects === null ||
    Array.isArray(policy.projects)
  ) reject();
  const projects = policy.projects as Record<string, unknown>;
  const pair = projects[`${repository}\0${project}`];
  if (typeof pair !== "object" || pair === null || Array.isArray(pair)) reject();
  if (Object.keys(pair).sort().join(",") !== "inbound_fingerprint,outbound_fingerprint")
    reject();
  if (
    !("inbound_fingerprint" in pair) ||
    !("outbound_fingerprint" in pair) ||
    typeof pair.inbound_fingerprint !== "string" ||
    typeof pair.outbound_fingerprint !== "string" ||
    !fingerprintPattern.test(pair.inbound_fingerprint) ||
    !fingerprintPattern.test(pair.outbound_fingerprint) ||
    pair.inbound_fingerprint === pair.outbound_fingerprint
  ) reject();
  return {
    inbound_public_var: `${prefix}_INBOUND_PUBLIC_KEY`,
    inbound_private_secret: `${prefix}_INBOUND_PRIVATE_KEY`,
    outbound_public_var: `${prefix}_OUTBOUND_PUBLIC_KEY`,
    outbound_private_secret: `${prefix}_OUTBOUND_PRIVATE_KEY`,
    inbound_fingerprint: pair.inbound_fingerprint,
    outbound_fingerprint: pair.outbound_fingerprint,
  };
}

async function main(): Promise<void> {
  const plan = await resolveProjectTransferKeyPlan(
    process.env.TASK_SOURCE_REPOSITORY ?? "",
    process.env.PROJECT ?? ""
  );
  await appendLines(
    process.env.GITHUB_OUTPUT,
    Object.entries(plan).map(([name, value]) => `${name}=${value}`)
  );
  console.log("Private transfer key identity verified against central project policy.");
}

if (isMain(import.meta.url)) main().catch(handleError);
