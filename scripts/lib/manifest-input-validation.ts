import { CliError } from "../runtime-command.ts";

/**
 * Shared allowlist for repository-relative paths accepted by trusted manifests.
 * Reject absolute/drive paths, traversal, separators outside POSIX format,
 * non-ASCII path characters, and oversized paths before further processing.
 */
export function isSafeRelativePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    !value.startsWith("/") &&
    !/^[A-Za-z]:[\\/]/.test(value) &&
    !value.split(/[\\/]+/).includes("..") &&
    /^[A-Za-z0-9._/-]+$/.test(value)
  );
}

export function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((item, index) => item !== wanted[index])) {
    throw new CliError(`${label} keys are invalid.`, 65);
  }
}
