import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { runText } from "../scripts/runtime-command.ts";
import { collectSecurityViolations } from "../scripts/validate-security.ts";

// Credential-shaped values are assembled at run time so this file never contains one.
const policyPath = resolve("policies/security.json");

async function git(root: string, args: readonly string[]): Promise<string> {
  return await runText("git", args, { cwd: root });
}

async function scan(
  context: { after(callback: () => Promise<void>): void },
  path: string,
  content: string,
  policy: string = policyPath
) {
  const root = await mkdtemp(join(tmpdir(), "action-worker-patterns-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await git(root, ["init", "-q"]);
  await git(root, ["config", "user.name", "Test"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await writeFile(join(root, "README.md"), "# Fixture\n", "utf8");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-qm", "base"]);
  const base = await git(root, ["rev-parse", "HEAD"]);
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content, "utf8");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-qm", "change"]);
  const head = await git(root, ["rev-parse", "HEAD"]);
  return await collectSecurityViolations(root, base, head, policy);
}

const mixed = (length: number): string =>
  "aB3dE5fG7hI9jK1lM3nO5pQ7rS9tU1vW".repeat(4).slice(0, length);

const credentials: Array<[string, string]> = [
  ["openai-anthropic-key", `sk-ant-api03-${mixed(40)}`],
  ["openai-anthropic-key", `sk-proj-${mixed(48)}`],
  ["openai-anthropic-key", `sk-${mixed(48)}`],
  ["nvidia-api-key", `nvapi-${mixed(40)}`],
  ["huggingface-token", `hf_${mixed(34)}`],
  ["tailscale-auth-key", `tskey-auth-${mixed(24)}`],
  ["cloudflare-api-token", `CLOUDFLARE_API_TOKEN="${mixed(40)}"`],
  ["cloudflare-api-token", `CLOUDFLARE_API_TOKEN: ${mixed(40)}`],
  [
    "jwt",
    `${["eyJ", "hbGciOiJIUzI1NiJ9"].join("")}.${["eyJ", "zdWIiOiIxMjM0NTY3ODkwIn0"].join("")}.${mixed(24)}`,
  ],
];

for (const [rule, value] of credentials) {
  test(`secret pattern ${rule} reports a ${value.slice(0, 5)}... credential without echoing it`, async (context) => {
    const violations = await scan(context, "src/config.txt", `value = ${value}\n`);
    assert.equal(
      violations.some((item) => item.rule === rule && item.path === "src/config.txt"),
      true,
      JSON.stringify(violations)
    );
    assert.equal(JSON.stringify(violations).includes(value), false);
  });
}

test("ordinary text that resembles the new patterns is not reported", async (context) => {
  const text = [
    "##.sk-component--cookie-message",
    "###sk-notifications-container",
    "use sk-learn and hf_cache_dir in notes",
    "the token hf_short is only an example",
    "CLOUDFLARE_API_TOKEN=${{ secrets.CLOUDFLARE_API_TOKEN }}",
    'export CLOUDFLARE_API_TOKEN="$CLOUDFLARE_TOKEN_FROM_VAULT"',
    "CLOUDFLARE_API_TOKEN=",
    "eyJhbGciOiJIUzI1NiJ9 alone is a header, not a token",
    "nvapi-key is the prefix",
    "tskey-auth is the prefix",
  ].join("\n");
  assert.deepEqual(await scan(context, "docs/notes.md", `${text}\n`), []);
});

// The synthetic key used by the internal-vault preflight tests, split so it is not written out here.
const fixture = `sk-proj-${"aB3dE5fG7hI9jK1lM3nO5p"}Q7`;

test("the one synthetic fixture value is allowed only in its own file", async (context) => {
  const value = fixture;
  const allowedPath = "tests/packs/internal-vault/unit/test_preflight.py";
  assert.deepEqual(await scan(context, allowedPath, `secret = "${value}"\n`), []);
  const elsewhere = await scan(context, "tests/other.py", `secret = "${value}"\n`);
  assert.equal(
    elsewhere.some((item) => item.rule === "openai-anthropic-key"),
    true
  );
});

test("an allowance for the fixture never excuses another credential in the same file", async (context) => {
  const real = `sk-proj-${mixed(60)}`;
  const allowedPath = "tests/packs/internal-vault/unit/test_preflight.py";
  const sameLine = await scan(context, allowedPath, `pair = ("${fixture}", "${real}")\n`);
  assert.equal(
    sameLine.some((item) => item.rule === "openai-anthropic-key"),
    true
  );
  const otherLine = await scan(context, allowedPath, `a = "${fixture}"\nb = "${real}"\n`);
  assert.deepEqual(
    otherLine.map((item) => [item.rule, item.line]),
    [["openai-anthropic-key", 2]]
  );
  const extended = await scan(context, allowedPath, `a = "${fixture}EXTRA${mixed(30)}"\n`);
  assert.equal(
    extended.some((item) => item.rule === "openai-anthropic-key"),
    true
  );
});

test("a secret allowance without a reason is rejected as an invalid policy", async (context) => {
  const policy = JSON.parse(await readFile(policyPath, "utf8"));
  policy.secret_allowlist = [{ path: "^a$", pattern: "b" }];
  const directory = await mkdtemp(join(tmpdir(), "action-worker-policy-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const broken = join(directory, "security.json");
  await writeFile(broken, JSON.stringify(policy), "utf8");
  await assert.rejects(() => scan(context, "src/a.txt", "plain\n", broken));
});


test("privacy patterns reject personal addresses and local home paths without capturing values", async (context) => {
  const email = ["developer", "example.invalid"].join("@");
  const unixHome = ["", "home", "developer", "settings.json"].join("/");
  const macHome = ["", "Users", "developer", "Documents", "notes.txt"].join("/");
  const windowsHome = ["C:", "Users", "developer", "Desktop", "notes.txt"].join("\\");
  for (const [name, value] of ([
    ["email-address", email],
    ["unix-home-path", unixHome],
    ["unix-home-path", macHome],
    ["windows-home-path", windowsHome],
  ] as Array<[string, string]>)) {
    const findings = await scan(context, "src/change.txt", `content: ${value}\n`);
    assert.ok(findings.some((v) => v.rule === `privacy-${name}`), name);
    assert.equal(JSON.stringify(findings).includes(value), false);
  }
});

test("privacy policies are mandatory and cannot be disabled by an empty ruleset", async (context) => {
  const policy = JSON.parse(await readFile(policyPath, "utf8"));
  policy.privacy_patterns = [];
  const directory = await mkdtemp(join(tmpdir(), "privacy-policy-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const broken = join(directory, "security.json");
  await writeFile(broken, JSON.stringify(policy), "utf8");
  await assert.rejects(() => scan(context, "src/clean.txt", "ordinary source\n", broken));
});

test("ordinary relative paths and public project links do not count as local private data", async (context) => {
  const findings = await scan(
    context, "src/config.txt",
    ["src/core/runtime.ts", "https://github.com/fongap-labs/action-worker", "tests/fixtures/data.json"].join("\n") + "\n"
  );
  assert.deepEqual(findings, []);
});
