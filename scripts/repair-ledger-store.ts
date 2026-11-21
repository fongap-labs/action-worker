import { requireToken } from "./control-token.ts";
import {
  decodeGithubContent,
  GithubReader,
  getJsonNumber,
  getJsonString,
  githubEnvironment,
  isGithubMissing,
  isJsonRecord,
} from "./github-api.ts";
import {
  applyRepairLedgerEvent,
  type RepairEvent,
  type RepairLedgerEntry,
  type RepairStage,
  repairTaskId,
} from "./repair-lifecycle-ledger.ts";
import { CliError, parseJson, runCommand } from "./runtime-command.ts";
import { openBytes, sealBytes } from "./task-state.ts";

const RECORD_PATH = "record.dat";
const RECORD_PREFIX = "AWREPAIR1";
const MAX_RECORD_BYTES = 64 * 1024;
const GIT_SHA = /^[0-9a-f]{40}$/;
const SHA_256 = /^[0-9a-f]{64}$/;
const REPOSITORY = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/;
const STAGES: readonly RepairStage[] = [
  "discovered",
  "diagnosed",
  "repairing",
  "ci_verifying",
  "completed",
];
const BLOCKS = ["missing_evidence", "permissions", "quota", "stale_head", "ci_failure"] as const;
const ENTRY_KEYS = [
  "blocked_reason",
  "ci_evidence_sha256",
  "ci_head_sha",
  "ci_run_id",
  "head_sha",
  "pr_number",
  "revision",
  "root_cause_evidence_sha256",
  "root_cause_sha256",
  "stage",
  "task_id",
  "updated_at",
]
  .sort()
  .join(",");

export interface RepairLedgerDocument {
  readonly schema_version: "1";
  readonly repository: string;
  readonly issue_number: number;
  readonly entry: RepairLedgerEntry;
}

export interface RepairLedgerSnapshot {
  readonly document: RepairLedgerDocument;
  readonly commit_sha: string;
  readonly tree_sha: string;
  readonly is_private: boolean;
}

export class RepairLedgerConflictError extends Error {
  readonly code = "REPAIR_LEDGER_CONFLICT";

  constructor() {
    super("Repair ledger changed concurrently; reload the current revision before retrying.");
    this.name = "RepairLedgerConflictError";
  }
}

export interface RepairLedgerGitApi {
  getRef(refName: string): Promise<string | null>;
  getCommitTree(commitSha: string): Promise<string>;
  getFile(path: string, commitSha: string): Promise<string>;
  createTree(baseTreeSha: string | null, path: string, content: string): Promise<string>;
  createCommit(treeSha: string, parentSha: string | null): Promise<string>;
  createRef(refName: string, commitSha: string): Promise<void>;
  updateRef(refName: string, commitSha: string): Promise<void>;
}

function assertPositive(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new CliError(`Repair ledger ${label} is invalid.`, 65);
  }
}

function assertSha(value: unknown, pattern: RegExp, label: string): asserts value is string {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new CliError(`Repair ledger ${label} is invalid.`, 65);
  }
}

function exactKeys(value: Record<string, unknown>, expected: string, label: string): void {
  if (Object.keys(value).sort().join(",") !== expected) {
    throw new CliError(`Repair ledger ${label} has an unsupported schema.`, 65);
  }
}

function nullableSha(value: unknown, pattern: RegExp, label: string): void {
  if (value !== null) assertSha(value, pattern, label);
}

function nullablePositive(value: unknown, label: string): void {
  if (value !== null) {
    if (typeof value !== "number")
      throw new CliError(`Repair ledger ${label} is invalid.`, 65);
    assertPositive(value, label);
  }
}

export function repairLedgerRefName(taskId: string): string {
  if (!/^repair-[0-9a-f]{32}$/.test(taskId)) {
    throw new CliError("Repair ledger task identity is invalid.", 65);
  }
  return `repair-ledger-${taskId.slice("repair-".length)}`;
}

export function validateRepairLedgerDocument(
  value: unknown,
  expectedRepository?: string,
  expectedIssueNumber?: number,
  expectedTaskId?: string
): RepairLedgerDocument {
  if (!isJsonRecord(value)) throw new CliError("Repair ledger document is invalid.", 65);
  exactKeys(value, "entry,issue_number,repository,schema_version", "document");
  if (
    value.schema_version !== "1" ||
    typeof value.repository !== "string" ||
    value.repository !== value.repository.toLowerCase() ||
    !REPOSITORY.test(value.repository)
  ) {
    throw new CliError("Repair ledger document identity is invalid.", 65);
  }
  if (expectedRepository !== undefined && value.repository !== expectedRepository.toLowerCase()) {
    throw new CliError("Repair ledger belongs to a different repository.", 65);
  }
  if (typeof value.issue_number !== "number") {
    throw new CliError("Repair ledger issue identity is invalid.", 65);
  }
  assertPositive(value.issue_number, "issue number");
  if (expectedIssueNumber !== undefined && value.issue_number !== expectedIssueNumber) {
    throw new CliError("Repair ledger belongs to a different issue.", 65);
  }
  if (!isJsonRecord(value.entry)) throw new CliError("Repair ledger entry is invalid.", 65);
  exactKeys(value.entry, ENTRY_KEYS, "entry");
  const entry = value.entry;
  assertSha(entry.root_cause_sha256, SHA_256, "root-cause fingerprint");
  const taskId = repairTaskId(value.repository, entry.root_cause_sha256);
  if (entry.task_id !== taskId || (expectedTaskId !== undefined && taskId !== expectedTaskId)) {
    throw new CliError("Repair ledger task identity does not match its root cause.", 65);
  }
  if (
    !Number.isSafeInteger(entry.revision) ||
    typeof entry.revision !== "number" ||
    entry.revision < 0
  ) {
    throw new CliError("Repair ledger revision is invalid.", 65);
  }
  if (typeof entry.stage !== "string" || !STAGES.includes(entry.stage as RepairStage)) {
    throw new CliError("Repair ledger stage is invalid.", 65);
  }
  nullableSha(entry.root_cause_evidence_sha256, SHA_256, "root-cause evidence");
  nullableSha(entry.ci_evidence_sha256, SHA_256, "CI evidence");
  nullableSha(entry.head_sha, GIT_SHA, "repair head");
  nullableSha(entry.ci_head_sha, GIT_SHA, "CI head");
  nullablePositive(entry.pr_number, "pull request number");
  nullablePositive(entry.ci_run_id, "CI run identifier");
  if (
    entry.blocked_reason !== null &&
    !BLOCKS.includes(entry.blocked_reason as (typeof BLOCKS)[number])
  ) {
    throw new CliError("Repair ledger block reason is invalid.", 65);
  }
  if (
    typeof entry.updated_at !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(entry.updated_at) ||
    Number.isNaN(Date.parse(entry.updated_at))
  ) {
    throw new CliError("Repair ledger timestamp is invalid.", 65);
  }
  if ((entry.ci_run_id === null) !== (entry.ci_head_sha === null)) {
    throw new CliError("Repair ledger CI identity is incomplete.", 65);
  }
  if (entry.ci_head_sha !== null && entry.ci_head_sha !== entry.head_sha) {
    throw new CliError("Repair ledger CI evidence belongs to a stale head.", 65);
  }
  if ((entry.head_sha === null) !== (entry.pr_number === null)) {
    throw new CliError("Repair ledger pull request identity is incomplete.", 65);
  }
  if (
    (entry.stage === "discovered" &&
      (entry.root_cause_evidence_sha256 !== null ||
        entry.ci_evidence_sha256 !== null ||
        entry.head_sha !== null)) ||
    (entry.stage === "diagnosed" &&
      (entry.root_cause_evidence_sha256 === null ||
        entry.ci_evidence_sha256 !== null ||
        entry.head_sha !== null)) ||
    (entry.stage === "repairing" &&
      (entry.root_cause_evidence_sha256 === null ||
        entry.ci_evidence_sha256 !== null ||
        entry.head_sha === null ||
        entry.ci_run_id !== null)) ||
    (entry.stage === "ci_verifying" &&
      (entry.root_cause_evidence_sha256 === null ||
        entry.ci_evidence_sha256 !== null ||
        entry.head_sha === null ||
        entry.ci_run_id === null)) ||
    (entry.stage === "completed" &&
      (entry.root_cause_evidence_sha256 === null ||
        entry.ci_evidence_sha256 === null ||
        entry.head_sha === null ||
        entry.ci_run_id === null ||
        entry.blocked_reason !== null))
  ) {
    throw new CliError("Repair ledger stage does not match its recorded evidence.", 65);
  }
  return value as unknown as RepairLedgerDocument;
}

function encodeRecord(
  document: RepairLedgerDocument,
  isPrivate: boolean,
  key: Buffer | null
): string {
  const plain = Buffer.from(JSON.stringify(document), "utf8");
  if (plain.length > MAX_RECORD_BYTES)
    throw new CliError("Repair ledger record exceeds its size limit.", 66);
  if (!isPrivate) return `${RECORD_PREFIX}:public:${plain.toString("base64")}`;
  if (key === null) throw new CliError("Private repair ledger requires AW_ARTIFACT_KEY.", 77);
  const sealed = sealBytes(
    key,
    "repair-ledger",
    document.repository,
    document.entry.task_id,
    plain
  );
  return `${RECORD_PREFIX}:sealed:${sealed.toString("base64")}`;
}

function decodeBase64(value: string): Buffer {
  if (
    value.length > Math.ceil((MAX_RECORD_BYTES + 64) / 3) * 4 + 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    throw new CliError("Repair ledger record encoding is invalid.", 65);
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value || bytes.length > MAX_RECORD_BYTES + 64) {
    throw new CliError("Repair ledger record encoding is invalid.", 65);
  }
  return bytes;
}

function decodeRecord(
  raw: string,
  repository: string,
  taskId: string,
  isPrivate: boolean,
  key: Buffer | null,
  issueNumber: number
): RepairLedgerDocument {
  const prefix = `${RECORD_PREFIX}:`;
  if (!raw.startsWith(prefix))
    throw new CliError("Repair ledger record has no valid envelope.", 65);
  const separator = raw.indexOf(":", prefix.length);
  if (separator < 0) throw new CliError("Repair ledger record has no valid envelope.", 65);
  const visibility = raw.slice(prefix.length, separator);
  const encoded = raw.slice(separator + 1);
  const bytes = decodeBase64(encoded);
  let plain: Buffer;
  if (isPrivate) {
    if (visibility !== "sealed" || key === null) {
      throw new CliError(
        "Private repair ledger cannot be opened with the supplied visibility or key.",
        77
      );
    }
    plain = openBytes(key, "repair-ledger", repository, taskId, bytes);
  } else {
    if (visibility !== "public") {
      throw new CliError("Public repair ledger has an unexpected encrypted envelope.", 65);
    }
    plain = bytes;
  }
  if (plain.length > MAX_RECORD_BYTES)
    throw new CliError("Repair ledger record exceeds its size limit.", 66);
  let parsed: unknown;
  try {
    parsed = JSON.parse(plain.toString("utf8")) as unknown;
  } catch {
    throw new CliError("Repair ledger record is not valid JSON.", 65);
  }
  return validateRepairLedgerDocument(parsed, repository, issueNumber, taskId);
}

export class RepairLedgerStore {
  private readonly api: RepairLedgerGitApi;

  constructor(api: RepairLedgerGitApi) {
    this.api = api;
  }

  async read(
    repository: string,
    issueNumber: number,
    rootCauseSha256: string,
    isPrivate: boolean,
    key: Buffer | null
  ): Promise<RepairLedgerSnapshot | null> {
    const normalizedRepository = repository.trim().toLowerCase();
    const taskId = repairTaskId(normalizedRepository, rootCauseSha256);
    assertPositive(issueNumber, "issue number");
    const refName = repairLedgerRefName(taskId);
    const commitSha = await this.api.getRef(refName);
    if (commitSha === null) return null;
    assertSha(commitSha, GIT_SHA, "commit");
    const treeSha = await this.api.getCommitTree(commitSha);
    assertSha(treeSha, GIT_SHA, "tree");
    const raw = await this.api.getFile(RECORD_PATH, commitSha);
    const document = decodeRecord(raw, normalizedRepository, taskId, isPrivate, key, issueNumber);
    return { document, commit_sha: commitSha, tree_sha: treeSha, is_private: isPrivate };
  }

  async create(
    document: RepairLedgerDocument,
    isPrivate: boolean,
    key: Buffer | null
  ): Promise<RepairLedgerSnapshot> {
    const valid = validateRepairLedgerDocument(document);
    if (valid.entry.revision !== 0 || valid.entry.stage !== "discovered") {
      throw new CliError("A new repair ledger must start at revision zero.", 65);
    }
    const refName = repairLedgerRefName(valid.entry.task_id);
    if ((await this.api.getRef(refName)) !== null) throw new RepairLedgerConflictError();
    const content = encodeRecord(valid, isPrivate, key);
    const treeSha = await this.api.createTree(null, RECORD_PATH, content);
    assertSha(treeSha, GIT_SHA, "tree");
    const commitSha = await this.api.createCommit(treeSha, null);
    assertSha(commitSha, GIT_SHA, "commit");
    await this.api.createRef(refName, commitSha);
    return { document: valid, commit_sha: commitSha, tree_sha: treeSha, is_private: isPrivate };
  }

  async compareAndSwap(
    snapshot: RepairLedgerSnapshot,
    event: RepairEvent,
    now: string,
    key: Buffer | null
  ): Promise<RepairLedgerSnapshot> {
    const current = validateRepairLedgerDocument(snapshot.document);
    if (event.kind === "ci-verified") {
      throw new CliError(
        "Repair completion requires trusted current-head GitHub CI verification.",
        77
      );
    }
    if (snapshot.is_private && key === null) {
      throw new CliError("Private repair ledger requires AW_ARTIFACT_KEY.", 77);
    }
    const refName = repairLedgerRefName(current.entry.task_id);
    const latest = await this.read(
      current.repository,
      current.issue_number,
      current.entry.root_cause_sha256,
      snapshot.is_private,
      key
    );
    if (
      latest === null ||
      latest.commit_sha !== snapshot.commit_sha ||
      JSON.stringify(latest.document) !== JSON.stringify(current)
    ) {
      throw new RepairLedgerConflictError();
    }
    const nextEntry = applyRepairLedgerEvent(current.entry, current.entry.revision, event, now);
    const next = validateRepairLedgerDocument(
      { ...current, entry: nextEntry },
      current.repository,
      current.issue_number,
      current.entry.task_id
    );
    const content = encodeRecord(next, snapshot.is_private, key);
    const treeSha = await this.api.createTree(latest.tree_sha, RECORD_PATH, content);
    assertSha(treeSha, GIT_SHA, "tree");
    const commitSha = await this.api.createCommit(treeSha, latest.commit_sha);
    assertSha(commitSha, GIT_SHA, "commit");
    await this.api.updateRef(refName, commitSha);
    return {
      document: next,
      commit_sha: commitSha,
      tree_sha: treeSha,
      is_private: snapshot.is_private,
    };
  }
}

function conflictFromWrite(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  if (/HTTP (?:409|422)|already exists|not a fast forward|reference update failed/i.test(message)) {
    throw new RepairLedgerConflictError();
  }
  throw error;
}

export class GitHubRepairLedgerGitApi implements RepairLedgerGitApi {
  private readonly reader: GithubReader;
  private readonly controlRepository: string;
  private readonly token: string;

  constructor(
    controlRepository: string,
    token: string,
    apiUrl = process.env.GITHUB_API_URL ?? "https://api.github.com"
  ) {
    this.controlRepository = controlRepository;
    this.token = token;
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(controlRepository) || !token) {
      throw new CliError("Repair ledger GitHub API scope is invalid.", 77);
    }
    this.reader = new GithubReader(apiUrl, token);
  }

  async getRef(refName: string): Promise<string | null> {
    try {
      const value = await this.reader.get(
        `repos/${this.controlRepository}/git/ref/heads/${refName}`
      );
      const sha = getJsonString(isJsonRecord(value) ? value.object : null, "sha");
      assertSha(sha, GIT_SHA, "ref");
      return sha;
    } catch (error) {
      if (isGithubMissing(error)) return null;
      throw error;
    }
  }

  async getCommitTree(commitSha: string): Promise<string> {
    const value = await this.reader.get(
      `repos/${this.controlRepository}/git/commits/${commitSha}`
    );
    const tree = isJsonRecord(value) ? value.tree : null;
    const sha = getJsonString(tree, "sha");
    assertSha(sha, GIT_SHA, "tree");
    return sha;
  }

  async getFile(path: string, commitSha: string): Promise<string> {
    const value = await this.reader.get(
      `repos/${this.controlRepository}/contents/${path}?ref=${commitSha}`
    );
    const size = getJsonNumber(value, "size");
    if (!isJsonRecord(value) || value.type !== "file" || size < 1 || size > MAX_RECORD_BYTES * 2) {
      throw new CliError("Repair ledger GitHub content is invalid or too large.", 65);
    }
    return decodeGithubContent(value, "Repair ledger GitHub content is invalid.");
  }

  async createTree(baseTreeSha: string | null, path: string, content: string): Promise<string> {
    const tree: Record<string, string>[] = [{ path, mode: "100644", type: "blob", content }];
    const body: Record<string, unknown> = { tree };
    if (baseTreeSha !== null) body.base_tree = baseTreeSha;
    const value = await this.writeApi(
      "POST",
      `repos/${this.controlRepository}/git/trees`,
      body
    );
    const sha = getJsonString(value, "sha");
    assertSha(sha, GIT_SHA, "created tree");
    return sha;
  }

  async createCommit(treeSha: string, parentSha: string | null): Promise<string> {
    const body: Record<string, unknown> = {
      message: "chore(task): persist repair lifecycle",
      tree: treeSha,
      parents: parentSha === null ? [] : [parentSha],
    };
    const value = await this.writeApi(
      "POST",
      `repos/${this.controlRepository}/git/commits`,
      body
    );
    const sha = getJsonString(value, "sha");
    assertSha(sha, GIT_SHA, "created commit");
    return sha;
  }

  async createRef(refName: string, commitSha: string): Promise<void> {
    try {
      await this.writeApi("POST", `repos/${this.controlRepository}/git/refs`, {
        ref: `refs/heads/${refName}`,
        sha: commitSha,
      });
    } catch (error) {
      conflictFromWrite(error);
    }
  }

  async updateRef(refName: string, commitSha: string): Promise<void> {
    try {
      await this.writeApi(
        "PATCH",
        `repos/${this.controlRepository}/git/refs/heads/${refName}`,
        {
          sha: commitSha,
          force: false,
        }
      );
    } catch (error) {
      conflictFromWrite(error);
    }
  }

  private async writeApi(
    method: "POST" | "PATCH",
    path: string,
    body: Record<string, unknown>
  ): Promise<unknown> {
    const output = await runCommand(
      "gh",
      ["api", "--method", method, path, "--input", "-"],
      {
        env: githubEnvironment(this.token),
        input: JSON.stringify(body),
        maxBuffer: 1024 * 1024,
        timeoutMs: 30_000,
      }
    );
    return parseJson(output.toString("utf8"), "GitHub repair ledger write returned invalid JSON.");
  }
}

export function createScopedRepairLedgerStore(
  controlRepository: string,
  env: NodeJS.ProcessEnv = process.env
): RepairLedgerStore {
  if (
    !env.GITHUB_REPOSITORY ||
    env.GITHUB_REPOSITORY.toLowerCase() !== controlRepository.toLowerCase()
  ) {
    throw new CliError("Repair ledger writes are restricted to the current control repository.", 77);
  }
  const token = requireToken("branch", env);
  return new RepairLedgerStore(
    new GitHubRepairLedgerGitApi(controlRepository, token, env.GITHUB_API_URL)
  );
}
