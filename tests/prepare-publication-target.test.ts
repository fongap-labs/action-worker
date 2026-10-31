import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  enforceRetention,
  parseAllowlist,
  parseRetentionPolicy,
  sanitizeManifest,
} from "../scripts/prepare-publication-target.ts";

async function makeTarget(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "prepare-publication-"));
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, content, "utf8");
  }
  return root;
}

function retentionConfig(limit: number): string {
  return `${JSON.stringify(
    { schema_version: "1", default_periods: limit, projects: { "output/marketbrief": limit } },
    null,
    2
  )}\n`;
}

function manifestJson(extra = ""): string {
  return `${JSON.stringify(
    { schema_version: "1", project: "marketbrief", editor_note: extra },
    null,
    2
  )}\n`;
}

test("retention policy parsing rejects malformed configs fail-closed", () => {
  assert.throws(() => parseRetentionPolicy({ schema_version: "2" }), /schema is invalid/);
  assert.throws(
    () => parseRetentionPolicy({ schema_version: "1", default_periods: 0, projects: {} }),
    /schema is invalid/
  );
  assert.throws(
    () =>
      parseRetentionPolicy({
        schema_version: "1",
        default_periods: 14,
        projects: { "../evil": 3 },
      }),
    /project entry is invalid/
  );
  assert.deepEqual(
    parseRetentionPolicy({
      schema_version: "1",
      default_periods: 14,
      projects: { "output/marketbrief": 7 },
    }),
    { defaultPeriods: 14, projects: { "output/marketbrief": 7 } }
  );
});

test("retention prunes the oldest periods until the marker count fits the limit", async (context) => {
  const root = await makeTarget({
    ".github/output-retention.json": retentionConfig(2),
    "output/marketbrief/2026-10-29/am/manifest.json": manifestJson(),
    "output/marketbrief/2026-10-30/am/manifest.json": manifestJson(),
    "output/marketbrief/2026-10-31/am/manifest.json": manifestJson(),
    "output/marketbrief/2026-10-31/am/brief.md": "# brief\n",
  });
  context.after(() => rm(root, { recursive: true, force: true }));

  const result = await enforceRetention(root, "output/marketbrief/2026-10-31/am");
  assert.equal(result.projectDir, "output/marketbrief");
  assert.deepEqual(result.pruned, ["output/marketbrief/2026-10-29"]);
  const remaining = await readFile(
    join(root, "output/marketbrief/2026-10-30/am/manifest.json"),
    "utf8"
  );
  assert.equal(JSON.parse(remaining).project, "marketbrief");
  await assert.rejects(() =>
    readFile(join(root, "output/marketbrief/2026-10-29/am/manifest.json"), "utf8")
  );
});

test("retention keeps everything when the count is within the limit", async (context) => {
  const root = await makeTarget({
    ".github/output-retention.json": retentionConfig(14),
    "output/marketbrief/2026-10-31/am/manifest.json": manifestJson(),
  });
  context.after(() => rm(root, { recursive: true, force: true }));

  const result = await enforceRetention(root, "output/marketbrief/2026-10-31/am");
  assert.deepEqual(result.pruned, []);
});

test("retention is skipped when the target declares no policy", async (context) => {
  const root = await makeTarget({
    "output/marketbrief/2026-10-31/am/manifest.json": manifestJson(),
  });
  context.after(() => rm(root, { recursive: true, force: true }));

  const result = await enforceRetention(root, "output/marketbrief/2026-10-31/am");
  assert.equal(result.projectDir, null);
  assert.deepEqual(result.pruned, []);
});

test("retention fails closed on a malformed target policy", async (context) => {
  const root = await makeTarget({
    ".github/output-retention.json": "{ not json",
    "output/marketbrief/2026-10-31/am/manifest.json": manifestJson(),
  });
  context.after(() => rm(root, { recursive: true, force: true }));

  await assert.rejects(
    () => enforceRetention(root, "output/marketbrief/2026-10-31/am"),
    /not valid JSON/
  );
});

const allowlist = `${JSON.stringify(
  {
    schema_version: "1",
    required_root_keys: ["schema_version", "project"],
    allowed_keys: ["schema_version", "project", "editor_note", "url"],
    url_fields: ["url"],
    url_required_fields: ["url"],
    blacklist_all: { windows_path: "[A-Za-z]:\\\\" },
    blacklist_non_url_fields: { url: "https?://" },
  },
  null,
  2
)}\n`;

test("manifest hygiene redacts URLs in non-URL fields and keeps URL fields intact", async (context) => {
  const root = await makeTarget({
    ".github/manifest-allowlist.json": allowlist,
    "output/marketbrief/2026-10-31/am/manifest.json": `${JSON.stringify(
      {
        schema_version: "1",
        project: "marketbrief",
        editor_note: "fallback_reason=403 for url: https://api.example.xyz/v1/chat/completions",
        url: "https://example.com/brief",
      },
      null,
      2
    )}\n`,
  });
  context.after(() => rm(root, { recursive: true, force: true }));

  const result = await sanitizeManifest(root, "output/marketbrief/2026-10-31/am");
  assert.equal(result.redactions, 1);
  assert.equal(result.changed, true);
  const written = JSON.parse(
    await readFile(join(root, "output/marketbrief/2026-10-31/am/manifest.json"), "utf8")
  );
  assert.equal(written.editor_note, "fallback_reason=403 for url: [url-redacted]");
  assert.equal(written.url, "https://example.com/brief");
});

test("manifest hygiene fails closed on remaining blacklist violations", async (context) => {
  const root = await makeTarget({
    ".github/manifest-allowlist.json": allowlist,
    "output/marketbrief/2026-10-31/am/manifest.json": manifestJson("see C:\\Users\\fong\\secret"),
  });
  context.after(() => rm(root, { recursive: true, force: true }));

  await assert.rejects(
    () => sanitizeManifest(root, "output/marketbrief/2026-10-31/am"),
    /violates the target manifest contract/
  );
});

test("manifest hygiene is skipped without an allowlist and leaves the manifest untouched", async (context) => {
  const original = manifestJson("https://api.example.xyz leaked");
  const root = await makeTarget({
    "output/marketbrief/2026-10-31/am/manifest.json": original,
  });
  context.after(() => rm(root, { recursive: true, force: true }));

  const result = await sanitizeManifest(root, "output/marketbrief/2026-10-31/am");
  assert.equal(result.changed, false);
  assert.equal(
    await readFile(join(root, "output/marketbrief/2026-10-31/am/manifest.json"), "utf8"),
    original
  );
});

test("allowlist parsing rejects invalid blacklist regexes", () => {
  assert.throws(
    () => parseAllowlist({ blacklist_all: { broken: "([" } }),
    /blacklist pattern is invalid/
  );
});
