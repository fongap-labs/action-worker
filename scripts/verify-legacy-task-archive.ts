import { gunzipSync } from "node:zlib";
import { CliError } from "./runtime-command.ts";

// This validator operates on the immutable decrypted bytes, before GNU tar sees them.
// It does not extract or execute archive content.
const BLOCK = 512;
const MAX_COMPRESSED = 16 * 1024 * 1024;
const MAX_EXPANDED = 48 * 1024 * 1024;
const MAX_SINGLE_FILE = 8 * 1024 * 1024;
const MAX_TOTAL_FILES = 2000;
const MAX_TOTAL_CONTENT = 16 * 1024 * 1024;
const MAX_METADATA = 1024 * 1024;

export type LegacyArchiveSummary = { entries: number; files: number; directories: number };

function refusal(): never {
  throw new CliError("Historical task state archive failed safe extraction validation.", 66);
}

function numeric(header: Buffer, start: number, length: number): number {
  const raw = header.subarray(start, start + length);
  if (raw[0] && (raw[0] & 0x80) !== 0) refusal();
  const value = raw.toString("ascii").replace(/\0.*$/s, "").trim();
  if (!/^[0-7]+$/.test(value)) refusal();
  const num = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(num) || num < 0) refusal();
  return num;
}

function zeroTerminated(data: Buffer): string {
  const end = data.indexOf(0);
  const bytes = end < 0 ? data : data.subarray(0, end);
  const decoded = bytes.toString("utf8");
  if (!Buffer.from(decoded, "utf8").equals(bytes)) refusal();
  return decoded;
}

function safeName(name: string, isDirectory: boolean): string | null {
  if (name === "." || name === "./") {
    if (!isDirectory) refusal();
    return null;
  }
  const stripped = name.startsWith("./") ? name.slice(2) : name;
  const normalized = isDirectory && stripped.endsWith("/") ? stripped.slice(0, -1) : stripped;
  const parts = normalized.split("/");
  if (
    !normalized ||
    Buffer.byteLength(normalized, "utf8") > 512 ||
    name !== name.normalize("NFC") ||
    name.startsWith("/") ||
    name.includes("\\") ||
    parts.length > 16 ||
    parts.some((part) => !part || part === "." || part === ".." || part === ".git") ||
    [...normalized].some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127)
  ) {
    refusal();
  }
  return normalized;
}

function paxPath(data: Buffer): string | null {
  let cursor = 0;
  let path: string | null = null;
  while (cursor < data.length) {
    const space = data.indexOf(32, cursor);
    if (space < 0) refusal();
    const lengthText = data.subarray(cursor, space).toString("ascii");
    if (!/^[1-9][0-9]{0,7}$/.test(lengthText)) refusal();
    const length = Number(lengthText);
    if (length < space - cursor + 3 || cursor + length > data.length) refusal();
    const record = data.subarray(space + 1, cursor + length);
    if (record[record.length - 1] !== 10) refusal();
    const body = record.subarray(0, -1);
    const equal = body.indexOf(61);
    if (equal < 1) refusal();
    const key = body.subarray(0, equal).toString("ascii");
    const bytes = body.subarray(equal + 1);
    const value = bytes.toString("utf8");
    if (!Buffer.from(value, "utf8").equals(bytes)) refusal();
    if (key === "path") {
      if (path !== null) refusal();
      path = value;
    } else if (!["mtime", "atime", "ctime"].includes(key)) {
      // Refuse GNU sparse, global attributes, and any metadata that changes extracted size.
      refusal();
    }
    cursor += length;
  }
  if (cursor !== data.length) refusal();
  return path;
}

export function inspectLegacyStateArchive(compressed: Buffer): LegacyArchiveSummary {
  if (
    !Buffer.isBuffer(compressed) ||
    compressed.length === 0 ||
    compressed.length > MAX_COMPRESSED
  ) {
    refusal();
  }
  let archive: Buffer;
  try {
    archive = gunzipSync(compressed, { maxOutputLength: MAX_EXPANDED });
  } catch {
    refusal();
  }
  if (archive.length < 2 * BLOCK || archive.length % BLOCK !== 0) refusal();

  const seen = new Set<string>();
  let offset = 0;
  let entries = 0;
  let files = 0;
  let directories = 0;
  let totalContent = 0;
  let nextLongName: string | null = null;
  let nextPaxName: string | null = null;
  let hasEnded = false;

  while (offset < archive.length) {
    const header = archive.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) {
      if (nextLongName !== null || nextPaxName !== null || offset + 2 * BLOCK > archive.length) {
        refusal();
      }
      if (!archive.subarray(offset).every((byte) => byte === 0)) refusal();
      hasEnded = true;
      break;
    }

    const expected = numeric(header, 148, 8);
    let actual = 0;
    for (let i = 0; i < BLOCK; i++) {
      actual += i >= 148 && i < 156 ? 32 : (header[i] ?? 0);
    }
    if (expected !== actual) refusal();

    const size = numeric(header, 124, 12);
    const type = header[156] ?? 0;
    const rawName = zeroTerminated(header.subarray(0, 100));
    const prefix = zeroTerminated(header.subarray(345, 500));
    const name = prefix ? `${prefix}/${rawName}` : rawName;
    const padded = Math.ceil(size / BLOCK) * BLOCK;
    const start = offset + BLOCK;
    const end = start + size;
    if (end > archive.length || start + padded > archive.length) refusal();
    const data = archive.subarray(start, end);
    offset = start + padded;

    if (type === 76 || type === 120) {
      if (size > MAX_METADATA || nextLongName !== null || nextPaxName !== null) refusal();
      if (type === 76) {
        nextLongName = zeroTerminated(data);
      } else {
        nextPaxName = paxPath(data);
      }
      continue;
    }

    const isFile = type === 48 || type === 0;
    const isDirectory = type === 53;
    if (!isFile && !isDirectory) refusal();
    if (isDirectory && size !== 0) refusal();
    if (isFile && size > MAX_SINGLE_FILE) refusal();
    const path = safeName(nextPaxName ?? nextLongName ?? name, isDirectory);
    nextLongName = null;
    nextPaxName = null;
    if (path === null) continue;
    const folded = path.toLowerCase();
    if (seen.has(folded)) refusal();
    seen.add(folded);
    entries++;
    if (entries > MAX_TOTAL_FILES) refusal();
    if (isDirectory) {
      directories++;
    } else {
      files++;
      totalContent += size;
      if (totalContent > MAX_TOTAL_CONTENT) refusal();
    }
  }

  if (!hasEnded || files + directories !== entries) refusal();
  return { entries, files, directories };
}
