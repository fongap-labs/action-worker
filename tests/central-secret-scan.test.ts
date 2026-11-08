import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  downloadFailureReason,
  gitleaksDownloadSources,
  GITLEAKS_LINUX_X64_ASSET_ID,
  scannerFailureReason,
  summarizeFindings,
} from "../scripts/central-secret-scan.ts";

const script = "scripts/central-secret-scan.ts";
const sha = (character: string): string => character.repeat(40);

// A stand-in for gitleaks: writes the report given on the command line and exits with 0.
async function fakeGitleaks(directory: string, findings: unknown[]): Promise<string> {
  const path = join(directory, "gitleaks.mjs");
  await writeFile(
    path,
    [
      'import { writeFileSync } from "node:fs";',
      "const args = process.argv.slice(2);",
      // Gitleaks v8.30.1 takes the git target as a positional argument, not --source.
      'if (args[0] !== "git" || args.includes("--source") || !args[1] || args[1].startsWith("--") || !args.includes("--log-opts")) process.exit(78);',
      'const out = args[args.indexOf("--report-path") + 1];',
      `writeFileSync(out, ${JSON.stringify(JSON.stringify(findings))});`,
      "",
    ].join("\n"),
    "utf8"
  );
  return path;
}

function run(
  directory: string,
  bin: string,
  env: Record<string, string>
): { status: number | null; output: string } {
  const result = spawnSync("node", [script, directory, sha("a"), sha("b")], {
    encoding: "utf8",
    env: { ...process.env, GITLEAKS_BIN: bin, RUNNER_TEMP: directory, ...env },
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

const finding = {
  RuleID: "generic-api-key",
  File: "src/config.ts",
  StartLine: 7,
  Secret: "REDACTED",
};

test("no findings: the scan passes in both modes", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "secret-scan-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const bin = await fakeGitleaks(directory, []);
  for (const mode of ["warn", "enforce"]) {
    const result = run(directory, bin, { AW_GITLEAKS_MODE: mode });
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /no findings/);
  }
});

test("warn mode reports findings and keeps the build green", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "secret-scan-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const bin = await fakeGitleaks(directory, [finding, finding, { ...finding, RuleID: "jwt" }]);
  const result = run(directory, bin, { TARGET_PRIVATE: "false", AW_GITLEAKS_MODE: "warn" });
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /::warning::central secret scan: 3 finding\(s\)/);
  assert.match(result.output, /generic-api-key x2, jwt x1/);
});

test("enforce mode fails when anything is found", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "secret-scan-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const bin = await fakeGitleaks(directory, [finding]);
  const result = run(directory, bin, { AW_GITLEAKS_MODE: "enforce" });
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /found 1 finding/);
});

test("a private target never has file names or lines in the public log", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "secret-scan-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const bin = await fakeGitleaks(directory, [finding]);
  const privateRun = run(directory, bin, { TARGET_PRIVATE: "true" });
  assert.equal(privateRun.output.includes("src/config.ts"), false);
  assert.match(privateRun.output, /1 finding\(s\)/);
  const publicRun = run(directory, bin, { TARGET_PRIVATE: "false" });
  assert.match(publicRun.output, /file=src\/config\.ts,line=7/);
  assert.equal(publicRun.output.includes("REDACTED") && publicRun.output.includes("Secret"), false);
});

test("a scan that cannot run is a warning in warn mode and a failure in enforce mode", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "secret-scan-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const broken = join(directory, "broken.mjs");
  await writeFile(broken, "process.exit(3);\n", "utf8");
  const warned = run(directory, broken, { AW_GITLEAKS_MODE: "warn" });
  assert.equal(warned.status, 0, warned.output);
  assert.match(warned.output, /could not run and was skipped/);
  const enforced = run(directory, broken, { AW_GITLEAKS_MODE: "enforce" });
  assert.equal(enforced.status, 1, enforced.output);
});

test("bad arguments and modes are refused", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "secret-scan-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const bin = await fakeGitleaks(directory, []);
  assert.equal(run(directory, bin, { AW_GITLEAKS_MODE: "maybe" }).status, 64);
  const shortSha = spawnSync("node", [script, directory, "abc", sha("b")], { encoding: "utf8" });
  assert.equal(shortSha.status, 64);
});

test("the pinned release and the workflow wiring are in place", async () => {
  const text = await readFile(script, "utf8");
  assert.match(text, /GITLEAKS_VERSION = "8\.30\.1"/);
  assert.match(text, /GITLEAKS_LINUX_X64_SHA256 =\s*"[0-9a-f]{64}"/);
  assert.match(text, /createHash\("sha256"\)/);
  const workflow = await readFile(".github/workflows/central-ci-sandbox.yml", "utf8");
  assert.match(workflow, /node aw-security\/scripts\/central-secret-scan\.ts/);
  assert.match(
    workflow,
    /AW_GITLEAKS_MODE: \$\{\{ vars\.AW_CENTRAL_GITLEAKS_MODE \|\| 'enforce' \}\}/
  );
});

test("findings are summarised by rule and annotated only for public targets", () => {
  const findings = [
    { RuleID: "jwt", File: "a.txt", StartLine: 1 },
    { RuleID: "jwt", File: "b.txt", StartLine: 2 },
    { RuleID: "aws-access-token", File: "c.txt", StartLine: 3 },
  ];
  const privateSummary = summarizeFindings(findings, false);
  assert.equal(privateSummary.count, 3);
  assert.equal(privateSummary.rules, "jwt x2, aws-access-token x1");
  assert.deepEqual(privateSummary.annotations, []);
  assert.equal(summarizeFindings(findings, true).annotations.length, 3);
  assert.throws(() => summarizeFindings({}, true));
});

test("scanner failures reveal safe categories but never leak private stderr", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "secret-scan-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const broken = join(directory, "broken.mjs");
  await writeFile(
    broken,
    'console.error("fatal: bad revision; secret=privateNeverLogThisValue"); process.exit(128);\n',
    "utf8"
  );
  const result = run(directory, broken, { TARGET_PRIVATE: "true", AW_GITLEAKS_MODE: "enforce" });
  assert.equal(result.status, 1);
  assert.match(result.output, /scanner could not resolve the Git commit range/);
  assert.doesNotMatch(result.output, /privateNeverLogThisValue/);
  assert.doesNotMatch(result.output, /fatal: bad revision/);
  assert.equal(
    scannerFailureReason(126, null, undefined, "Error: unknown flag --unsupported"),
    "scanner rejected a CLI option"
  );
  assert.equal(
    scannerFailureReason(null, null, Object.assign(new Error("too much"), { code: "ENOBUFS" }), ""),
    "scanner output exceeded the bounded capture buffer"
  );
});

test("release downloads classify HTTP and transport failures without exposing stderr", async () => {
  const source = await readFile(script, "utf8");
  assert.match(source, /spawnSync\(\s*"curl"/);
  assert.match(source, /--retry-all-errors/);
  assert.match(source, /--proto",\s*"=https"/);
  assert.match(source, /--proto-redir",\s*"=https"/);
  const sources = gitleaksDownloadSources();
  assert.equal(sources.length, 2);
  const [direct, api] = sources;
  assert.ok(direct);
  assert.ok(api);
  assert.equal(direct.url, "https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_x64.tar.gz");
  assert.equal(GITLEAKS_LINUX_X64_ASSET_ID, 378332058);
  assert.equal(api.url, "https://api.github.com/repos/gitleaks/gitleaks/releases/assets/378332058");
  assert.deepEqual(api.headers, ["Accept: application/octet-stream", "X-GitHub-Api-Version: 2022-11-28"]);
  assert.match(source, /if \(!hasDownloadedArchive\) throw new CannotRun\(lastFailure\)/);
  assert.doesNotMatch(source, /fetch\(url/);
  assert.equal(downloadFailureReason(22, null, undefined, "403"), "download returned HTTP 403");
  assert.equal(
    downloadFailureReason(28, null, undefined, "000"),
    "download process failed with code 28"
  );
  assert.equal(
    downloadFailureReason(null, null, Object.assign(new Error("missing"), { code: "ENOENT" }), ""),
    "curl executable not found"
  );
});

test("a pinned historical test pack cannot downgrade the current central security scanner", async () => {
  const workflow = await readFile(".github/workflows/central-ci-sandbox.yml", "utf8");
  const securityCheckout = workflow.indexOf("- name: Checkout current central security scanner");
  const pinnedPack = workflow.indexOf("- name: Pin central test pack");
  const scannerRun = workflow.indexOf("node aw-security/scripts/central-secret-scan.ts");
  assert.ok(securityCheckout >= 0 && pinnedPack > securityCheckout && scannerRun > pinnedPack);
  const securityBlock = workflow.slice(securityCheckout, pinnedPack);
  assert.match(securityBlock, /ref: \$\{\{ github\.sha \}\}/);
  assert.match(securityBlock, /path: aw-security/);
  assert.match(securityBlock, /persist-credentials: false/);
  assert.doesNotMatch(workflow, /node aw\/scripts\/central-secret-scan\.ts/);
});
