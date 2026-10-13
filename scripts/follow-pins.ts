import { parse as parseToml } from "smol-toml";
import { isJsonRecord } from "./github-api.ts";
import { isRepositoryRelativePath } from "./product-discovery.ts";
import { CliError } from "./runtime-command.ts";

// A follower declares what it follows and which values in its own files pin the upstream release.
// A pin names a file, a key inside it, and the kind of value: a commit or a stable-or-pre-release
// version. JSON keys are JSON Pointers; TOML keys are dotted paths. The file is edited in place,
// one occurrence at a time, and every edit is checked against a re-parse of the whole file.

export type PinValue = "commit" | "version";

export type FollowPin = {
  path: string;
  key: string;
  value: PinValue;
};

export type FollowManifest = {
  upstream: { repository: string; release_key: string };
  pins: FollowPin[];
  lockfile?: "uv";
};

// One replacement inside a pin file: the key, the kind it must hold, and the new value.
export type PinEdit = {
  key: string;
  kind: PinValue;
  to: string;
};

export type PinFormat = "json" | "toml";

const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const releaseKeyPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const commitPattern = /^[0-9a-f]{40}$/;
const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const tomlSegmentPattern = /^[A-Za-z0-9_-]+$/;
const maxPins = 32;
const maxKeyLength = 256;

export function isPinValueOf(kind: PinValue, value: unknown): value is string {
  if (typeof value !== "string") return false;
  return kind === "commit" ? commitPattern.test(value) : semverPattern.test(value);
}

export function pinFormat(path: string): PinFormat {
  if (path.endsWith(".json")) return "json";
  if (path.endsWith(".toml")) return "toml";
  throw new CliError(`Follow pin file must be a .json or .toml file: ${path}.`, 65);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((item, index) => item !== wanted[index])) {
    throw new CliError(`${label} keys are invalid.`, 65);
  }
}

export function parseFollowManifest(value: unknown): FollowManifest {
  if (!isJsonRecord(value)) {
    throw new CliError("Follow manifest must be a JSON object.", 65);
  }
  const allowed = ["lockfile", "pins", "upstream"];
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key))
      throw new CliError(`Follow manifest has an unknown key: ${key}.`, 65);
  }
  if (!isJsonRecord(value.upstream)) {
    throw new CliError("Follow manifest upstream must be an object.", 65);
  }
  exactKeys(value.upstream, ["release_key", "repository"], "Follow manifest upstream");
  const { repository, release_key: releaseKey } = value.upstream;
  if (
    typeof repository !== "string" ||
    !repositoryPattern.test(repository) ||
    typeof releaseKey !== "string" ||
    !releaseKeyPattern.test(releaseKey)
  ) {
    throw new CliError("Follow manifest upstream is invalid.", 65);
  }

  if (!Array.isArray(value.pins) || value.pins.length === 0 || value.pins.length > maxPins) {
    throw new CliError(`Follow manifest must declare between 1 and ${maxPins} pins.`, 65);
  }
  const seen = new Set<string>();
  const pins = value.pins.map((raw): FollowPin => {
    if (!isJsonRecord(raw)) throw new CliError("Follow pin must be an object.", 65);
    exactKeys(raw, ["key", "path", "value"], "Follow pin");
    if (
      typeof raw.path !== "string" ||
      !isRepositoryRelativePath(raw.path) ||
      typeof raw.key !== "string" ||
      raw.key === "" ||
      raw.key.length > maxKeyLength ||
      (raw.value !== "commit" && raw.value !== "version")
    ) {
      throw new CliError("Follow pin is invalid.", 65);
    }
    pinFormat(raw.path);
    const identity = `${raw.path}\n${raw.key}`;
    if (seen.has(identity)) {
      throw new CliError(`Follow pin is declared twice: ${raw.path} ${raw.key}.`, 65);
    }
    seen.add(identity);
    return { path: raw.path, key: raw.key, value: raw.value };
  });

  if (value.lockfile !== undefined && value.lockfile !== "uv") {
    throw new CliError('Follow manifest lockfile must be "uv" when declared.', 65);
  }
  return {
    upstream: { repository, release_key: releaseKey },
    pins,
    ...(value.lockfile === undefined ? {} : { lockfile: "uv" as const }),
  };
}

export function parseDocument(format: PinFormat, text: string, path: string): unknown {
  try {
    return format === "json" ? JSON.parse(text) : parseToml(text);
  } catch {
    throw new CliError(`Follow pin file is not valid ${format.toUpperCase()}: ${path}.`, 65);
  }
}

// JSON Pointer segments, with the RFC 6901 escapes; TOML dotted segments are bare keys only.
function segmentsOf(format: PinFormat, key: string, path: string): string[] {
  if (format === "json") {
    if (!key.startsWith("/") || key === "/") {
      throw new CliError(`Follow pin key must be a JSON Pointer in ${path}: ${key}.`, 65);
    }
    return key
      .slice(1)
      .split("/")
      .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
  }
  const segments = key.split(".");
  if (segments.some((segment) => !tomlSegmentPattern.test(segment))) {
    throw new CliError(`Follow pin key must be a dotted TOML path in ${path}: ${key}.`, 65);
  }
  return segments;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date)
  );
}

function getAt(document: unknown, segments: readonly string[]): unknown {
  let current: unknown = document;
  for (const segment of segments) {
    if (!isPlainObject(current) || !Object.hasOwn(current, segment)) return undefined;
    current = current[segment];
  }
  return current;
}

function setAt(document: unknown, segments: readonly string[], value: unknown): unknown {
  const copy = structuredClone(document);
  let current = copy as Record<string, unknown>;
  for (const segment of segments.slice(0, -1)) {
    current = current[segment] as Record<string, unknown>;
  }
  current[segments[segments.length - 1] as string] = value;
  return copy;
}

export function sameValue(left: unknown, right: unknown): boolean {
  if (left instanceof Date || right instanceof Date) {
    return left instanceof Date && right instanceof Date && left.getTime() === right.getTime();
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => sameValue(item, right[index]))
    );
  }
  if (isPlainObject(left) && isPlainObject(right)) {
    const keys = Object.keys(left).sort();
    const other = Object.keys(right).sort();
    return (
      keys.length === other.length &&
      keys.every((key, index) => key === other[index] && sameValue(left[key], right[key]))
    );
  }
  return left === right;
}

// Every leaf path whose value differs between the two documents, as segment lists.
function changedSegments(
  left: unknown,
  right: unknown,
  prefix: readonly string[] = []
): string[][] {
  if (isPlainObject(left) && isPlainObject(right)) {
    const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
    return keys.flatMap((key) => {
      const inLeft = Object.hasOwn(left, key);
      const inRight = Object.hasOwn(right, key);
      if (!inLeft || !inRight) return [[...prefix, key]];
      return changedSegments(left[key], right[key], [...prefix, key]);
    });
  }
  return sameValue(left, right) ? [] : [[...prefix]];
}

function signature(segments: readonly string[]): string {
  return JSON.stringify(segments);
}

// The positions where the old value appears as a complete quoted string in the file text.
function quotedOccurrences(
  text: string,
  value: string,
  format: PinFormat
): Array<{ index: number; quote: string }> {
  const quotes = format === "json" ? ['"'] : ['"', "'"];
  const found: Array<{ index: number; quote: string }> = [];
  for (const quote of quotes) {
    const needle = `${quote}${value}${quote}`;
    let index = text.indexOf(needle);
    while (index !== -1) {
      found.push({ index, quote });
      index = text.indexOf(needle, index + needle.length);
    }
  }
  return found;
}

/**
 * Applies pin edits to one file's text. Each edit must find exactly one quoted occurrence of the old
 * value whose replacement changes only the declared key; the final file must change only the declared
 * keys. Any failure rejects the whole file, and the text is never re-serialized.
 */
export function editPinFile(path: string, text: string, edits: readonly PinEdit[]): string {
  const format = pinFormat(path);
  const original = parseDocument(format, text, path);
  let expected = structuredClone(original);
  let current = text;
  const declared: string[] = [];
  const seen = new Set<string>();

  for (const edit of edits) {
    const segments = segmentsOf(format, edit.key, path);
    const identity = signature(segments);
    if (seen.has(identity)) {
      throw new CliError(`Follow pin is declared twice in ${path}: ${edit.key}.`, 65);
    }
    seen.add(identity);

    const from = getAt(original, segments);
    if (!isPinValueOf(edit.kind, from)) {
      throw new CliError(
        `Follow pin ${edit.key} in ${path} must hold a single ${edit.kind} string.`,
        65
      );
    }
    if (!isPinValueOf(edit.kind, edit.to)) {
      throw new CliError(`New ${edit.kind} value for ${edit.key} in ${path} is invalid.`, 65);
    }

    // A pin already at its value needs no edit; replacing it with itself would only look ambiguous.
    if (from === edit.to) continue;

    const next = setAt(expected, segments, edit.to);
    const matches = quotedOccurrences(current, from, format).filter(({ index, quote }) => {
      const replaced =
        current.slice(0, index) +
        `${quote}${edit.to}${quote}` +
        current.slice(index + from.length + 2);
      try {
        return sameValue(parseDocument(format, replaced, path), next);
      } catch {
        return false;
      }
    });
    if (matches.length === 0) {
      throw new CliError(
        `No occurrence of the current value of ${edit.key} in ${path} changes only that key.`,
        65
      );
    }
    if (matches.length > 1) {
      throw new CliError(
        `${matches.length} occurrences of the current value of ${edit.key} in ${path} change only that key; the edit is ambiguous.`,
        65
      );
    }

    const [match] = matches as [{ index: number; quote: string }];
    current =
      current.slice(0, match.index) +
      `${match.quote}${edit.to}${match.quote}` +
      current.slice(match.index + from.length + 2);
    expected = next;
    declared.push(identity);
  }

  const final = parseDocument(format, current, path);
  if (!sameValue(final, expected)) {
    throw new CliError(`Follow pin file ${path} does not match the expected edits.`, 65);
  }
  const changed = changedSegments(original, final).map(signature).sort();
  if (
    changed.length !== declared.length ||
    changed.some((item, index) => item !== [...declared].sort()[index])
  ) {
    throw new CliError(
      `Follow pin edit in ${path} changed keys that were not declared: ${changed.join(", ")}.`,
      65
    );
  }
  return current;
}

/** The value a pin key holds in a file's text, or undefined when the key is absent. */
export function pinValueAt(path: string, text: string, key: string): unknown {
  const format = pinFormat(path);
  return getAt(parseDocument(format, text, path), segmentsOf(format, key, path));
}

/** Groups a manifest's pins by file, with the new value that each pin should hold. */
export function groupPinEdits(
  pins: readonly FollowPin[],
  valueFor: (pin: FollowPin) => string
): Map<string, PinEdit[]> {
  const groups = new Map<string, PinEdit[]>();
  for (const pin of pins) {
    const edits = groups.get(pin.path) ?? [];
    edits.push({ key: pin.key, kind: pin.value, to: valueFor(pin) });
    groups.set(pin.path, edits);
  }
  return groups;
}
