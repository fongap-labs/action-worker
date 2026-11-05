import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isJsonRecord } from "./github-api.ts";
import { CliError } from "./runtime-command.ts";

// Caller must encrypt this payload with the identity-bound task-transfer envelope before upload.
// Never use the decoded payload as executable code on the privileged runner.
const MAX_ENTRIES = 2000;
const MAX_DEPTH = 16;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 10 * 1024 * 1024;
const MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
const MAX_PATH_BYTES = 512;
const base64Pattern = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export type TransferEntry =
  | { kind: "directory"; path: string }
  | { kind: "file"; path: string; base64: string };

function assertSafePath(path: string): void {
  const parts = path.split("/");
  if (
    !path ||
    Buffer.byteLength(path, "utf8") > MAX_PATH_BYTES ||
    path !== path.normalize("NFC") ||
    path.startsWith("/") ||
    path.includes("\\") ||
    parts.length > MAX_DEPTH ||
    parts.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        part === ".git" ||
        !/^[\p{L}\p{N}._-]+$/u.test(part)
    )
  ) {
    throw new CliError("Task transfer contains an unsafe path.", 66);
  }
}

async function visit(
  root: string,
  relative: string,
  entries: TransferEntry[],
  counters: { bytes: number }
): Promise<void> {
  const path = relative ? join(root, ...relative.split("/")) : root;
  const directory = await lstat(path);
  if (!directory.isDirectory() || directory.isSymbolicLink()) {
    throw new CliError("Task transfer directory is unsafe.", 66);
  }
  const children = await readdir(path);
  for (const child of children) {
    const relativeName = relative ? relative + "/" + child : child;
    assertSafePath(relativeName);
    if (entries.length >= MAX_ENTRIES) {
      throw new CliError("Task transfer exceeds the entry limit.", 66);
    }
    const name = join(root, ...relativeName.split("/"));
    const before = await lstat(name);
    if (before.isSymbolicLink()) {
      throw new CliError("Task transfer refuses symbolic links.", 66);
    }
    if (before.isDirectory()) {
      entries.push({ kind: "directory", path: relativeName });
      await visit(root, relativeName, entries, counters);
      continue;
    }
    if (!before.isFile() || before.nlink !== 1 || before.size > MAX_FILE_BYTES) {
      throw new CliError("Task transfer refuses unsafe or oversized files.", 66);
    }
    const handle = await open(name, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    let bytes: Buffer;
    try {
      const info = await handle.stat();
      if (
        !info.isFile() ||
        info.nlink !== 1 ||
        info.dev !== before.dev ||
        info.ino !== before.ino ||
        info.size !== before.size ||
        counters.bytes + info.size > MAX_TOTAL_BYTES
      ) {
        throw new CliError("Task transfer file changed or exceeded the limit.", 66);
      }
      bytes = await handle.readFile();
      const after = await handle.stat();
      if (bytes.length !== info.size || after.size !== info.size || after.nlink !== 1) {
        throw new CliError("Task transfer file changed during reading.", 66);
      }
    } finally {
      await handle.close();
    }
    counters.bytes += bytes.length;
    entries.push({ kind: "file", path: relativeName, base64: bytes.toString("base64") });
  }
}

export async function packTaskTransferFiles(root: string): Promise<Buffer> {
  const entries: TransferEntry[] = [];
  await visit(root, "", entries, { bytes: 0 });
  entries.sort((left, right) => left.path.localeCompare(right.path));
  const encoded = Buffer.from(JSON.stringify({ schema_version: "1", entries }), "utf8");
  if (encoded.length > MAX_PAYLOAD_BYTES) {
    throw new CliError("Task transfer encoded payload exceeds the limit.", 66);
  }
  return encoded;
}

function decodedFile(value: unknown): Buffer {
  if (
    typeof value !== "string" ||
    value.length > Math.ceil(MAX_FILE_BYTES / 3) * 4 + 4 ||
    !base64Pattern.test(value)
  ) {
    throw new CliError("Task transfer contains invalid file encoding.", 66);
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.length > MAX_FILE_BYTES || bytes.toString("base64") !== value) {
    throw new CliError("Task transfer contains invalid file encoding.", 66);
  }
  return bytes;
}

export function validateTaskTransferFiles(input: Buffer): TransferEntry[] {
  if (!Buffer.isBuffer(input) || input.length > MAX_PAYLOAD_BYTES) {
    throw new CliError("Task transfer file payload exceeds the limit.", 66);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(input.toString("utf8")) as unknown;
  } catch {
    throw new CliError("Task transfer file payload is malformed.", 66);
  }
  if (
    !isJsonRecord(raw) ||
    raw.schema_version !== "1" ||
    Object.keys(raw).sort().join(",") !== "entries,schema_version" ||
    !Array.isArray(raw.entries) ||
    raw.entries.length > MAX_ENTRIES
  ) {
    throw new CliError("Task transfer file payload schema is invalid.", 66);
  }
  const entries: TransferEntry[] = [];
  const seen = new Map<string, "file" | "directory">();
  let total = 0;
  for (const item of raw.entries) {
    if (!isJsonRecord(item) || typeof item.path !== "string") {
      throw new CliError("Task transfer file entry is invalid.", 66);
    }
    assertSafePath(item.path);
    const folded = item.path.toLocaleLowerCase("en-US");
    if (seen.has(folded)) {
      throw new CliError("Task transfer contains duplicated paths.", 66);
    }
    if (item.kind === "directory" && Object.keys(item).sort().join(",") === "kind,path") {
      seen.set(folded, "directory");
      entries.push({ kind: "directory", path: item.path });
    } else if (
      item.kind === "file" &&
      Object.keys(item).sort().join(",") === "base64,kind,path"
    ) {
      const data = decodedFile(item.base64);
      total += data.length;
      if (total > MAX_TOTAL_BYTES) {
        throw new CliError("Task transfer files exceed the total size limit.", 66);
      }
      seen.set(folded, "file");
      entries.push({ kind: "file", path: item.path, base64: data.toString("base64") });
    } else {
      throw new CliError("Task transfer file entry schema is invalid.", 66);
    }
  }
  for (const entry of entries) {
    const parts = entry.path.toLocaleLowerCase("en-US").split("/");
    for (let index = 1; index < parts.length; index++) {
      const parent = parts.slice(0, index).join("/");
      if (seen.get(parent) !== "directory") {
        throw new CliError("Task transfer contains a missing or unsafe parent directory.", 66);
      }
    }
  }
  return entries;
}

export async function unpackTaskTransferFiles(input: Buffer, destination: string): Promise<void> {
  // Validate every entry before creating even the root directory.
  const entries = validateTaskTransferFiles(input);
  await mkdir(destination, { mode: 0o700 });
  const ordered = [...entries].sort(
    (a, b) => a.path.split("/").length - b.path.split("/").length
  );
  for (const entry of ordered) {
    const path = join(destination, ...entry.path.split("/"));
    if (entry.kind === "directory") {
      await mkdir(path, { mode: 0o700 });
    } else {
      await writeFile(path, Buffer.from(entry.base64, "base64"), { flag: "wx", mode: 0o600 });
    }
  }
}
