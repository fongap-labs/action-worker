import { appendLines, CliError, handleError, isMain, runText } from "./runtime-command.ts";

const HAN = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/u;
const MARKDOWN = /\.md$/i;
const CONTENT_FILE = /\.(?:txt|csv|tsv)$/i;
const LOCALIZATION =
  /(^|\/)(?:i18n|locales?|translations?|messages)(\/|$)|(?:^|[._-])zh(?:[-_.](?:CN|Hans))?(?:[._-]|$)/i;
const WORKFLOW = /^\.github\/workflows\/.*\.ya?ml$/i;
// Minified third-party bundles are not authored engineering text; their built-in strings (for example
// a charting library's Chinese locale) cannot be changed by the repository that vendors them.
const MINIFIED_BUNDLE = /\.min\.(?:js|css)$/i;
const CONFIG_KEY =
  /(?:["'][^"']*[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF][^"']*["']\s*:)|(?:^|\s)[^:#"'\s]*[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF][^:#"']*\s*:/u;
const MACHINE_TEXT =
  /\b(?:console\.(?:log|error|warn|info|debug)|logger\w*|log\w*\s*\(|throw\s+new\s+\w*Error|new\s+\w*Error\s*\(|raise\s+\w*Error|logging\.|print\s*\(|describe\s*\(|it\s*\(|test\s*\()/i;

export function containsHan(value: string): boolean {
  return HAN.test(value);
}

export function assertEnglishText(label: string, value: string): void {
  if (containsHan(value)) {
    throw new CliError(`::error::${label} must use English engineering text.`, 65);
  }
}

function stripQuotedStrings(line: string): string {
  return line
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/`(?:\\.|[^`\\])*`/g, "``");
}

export function engineeringLineViolation(path: string, line: string): string | null {
  if (!containsHan(line)) {
    return null;
  }
  if (path === "CHANGELOG.md") {
    return "CHANGELOG entries must use English.";
  }
  if (
    MARKDOWN.test(path) ||
    LOCALIZATION.test(path) ||
    CONTENT_FILE.test(path) ||
    MINIFIED_BUNDLE.test(path)
  ) {
    return null;
  }
  if (WORKFLOW.test(path)) {
    return "Workflow engineering text must use English.";
  }
  if (CONFIG_KEY.test(line)) {
    return "Configuration keys must use English.";
  }
  if (MACHINE_TEXT.test(line)) {
    return "Logs, errors, and test descriptions must use English.";
  }
  if (containsHan(stripQuotedStrings(line))) {
    return "Engineering identifiers and comments must use English.";
  }
  return null;
}

const QUOTED_ESCAPES: Record<string, number> = {
  a: 0x07,
  b: 0x08,
  f: 0x0c,
  n: 0x0a,
  r: 0x0d,
  t: 0x09,
  v: 0x0b,
  '"': 0x22,
  "\\": 0x5c,
};

// Git writes a path with non-ASCII or special characters as a C-style quoted string with octal
// escapes, for example `+++ "b/\350\201\224.md"`; decode it back into the real path.
function unquoteGitPath(quoted: string): string {
  const bytes: number[] = [];
  const inner = quoted.slice(1, -1);
  for (let index = 0; index < inner.length; index += 1) {
    const char = inner[index] ?? "";
    if (char !== "\\") {
      bytes.push(...Buffer.from(char, "utf8"));
      continue;
    }
    const octal = /^[0-7]{3}/.exec(inner.slice(index + 1, index + 4))?.[0];
    if (octal) {
      bytes.push(Number.parseInt(octal, 8));
      index += 3;
      continue;
    }
    const escaped = inner[index + 1] ?? "";
    bytes.push(QUOTED_ESCAPES[escaped] ?? escaped.charCodeAt(0));
    index += 1;
  }
  return Buffer.from(bytes).toString("utf8");
}

/** Path named by a `+++ ` diff header, or null for `/dev/null` and unrecognised headers. */
export function diffHeaderPath(header: string): string | null {
  if (!header.startsWith("+++ ")) {
    return null;
  }
  const target = header.slice(4).replace(/\t.*$/, "");
  const unquoted = target.startsWith('"') && target.endsWith('"') ? unquoteGitPath(target) : target;
  return unquoted.startsWith("b/") ? unquoted.slice(2) : null;
}

export async function validateEngineeringDiff(
  base: string,
  head: string,
  root: string
): Promise<{ files: number; additions: number; failures: number }> {
  const diff = await runText("git", ["diff", "--unified=0", "--diff-filter=ACMR", base, head], {
    cwd: root,
  });
  let path = "";
  let files = 0;
  let additions = 0;
  let failures = 0;
  const seen = new Set<string>();
  for (const raw of diff.split(/\r?\n/)) {
    if (raw.startsWith("diff --git ")) {
      // A header that is not recognised below must not inherit the previous file's path.
      path = "";
      continue;
    }
    if (raw.startsWith("+++ ")) {
      path = diffHeaderPath(raw) ?? "";
      if (path && !seen.has(path)) {
        seen.add(path);
        files += 1;
      }
      continue;
    }
    if (!path || !raw.startsWith("+") || raw.startsWith("+++")) {
      continue;
    }
    additions += 1;
    const line = raw.slice(1);
    const violation = engineeringLineViolation(path, line);
    if (violation) {
      console.log(`::error file=${path}::${violation}`);
      failures += 1;
    }
  }
  return { files, additions, failures };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 3) {
    throw new CliError(
      "Usage: validate-engineering-language.ts <base-sha> <head-sha> <repo-root>",
      64
    );
  }
  const result = await validateEngineeringDiff(args[0] ?? "", args[1] ?? "", args[2] ?? "");
  await appendLines(process.env.GITHUB_STEP_SUMMARY, [
    "## Engineering language",
    "",
    `- Changed files: ${result.files}`,
    `- Added lines: ${result.additions}`,
    `- Violations: ${result.failures}`,
    "",
    "Rule: engineering diffs, PR titles, and CHANGELOG entries use English; documentation, localization, and plain data content are exempt.",
  ]);
  if (result.failures > 0) {
    process.exit(1);
  }
}

if (isMain(import.meta.url)) {
  main().catch(handleError);
}
