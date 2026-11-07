import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parse } from "yaml";
import { verifyPublicationKeyPair } from "../scripts/verify-publication-key-pair.ts";

function keys(bits: number) {
  const pair = generateKeyPairSync("rsa", {
    modulusLength: bits,
    publicKeyEncoding: { type: "spki", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return { publicKey: pair.publicKey.toString("base64"), privateKey: pair.privateKey };
}

test("protected publication preflight accepts a correct RSA-3072 pair", () => {
  const pair = keys(3072);
  assert.doesNotThrow(() => verifyPublicationKeyPair(pair.publicKey, pair.privateKey));
  assert.throws(
    () => verifyPublicationKeyPair("", pair.privateKey),
    /missing, invalid, or mismatched/
  );
  assert.throws(
    () => verifyPublicationKeyPair(pair.publicKey, ""),
    /missing, invalid, or mismatched/
  );
  assert.throws(
    () => verifyPublicationKeyPair("not-base64!", pair.privateKey),
    /missing, invalid, or mismatched/
  );
  const other = keys(3072);
  assert.throws(
    () => verifyPublicationKeyPair(pair.publicKey, other.privateKey),
    /missing, invalid, or mismatched/
  );
});

test("protected publication preflight refuses RSA below 3072 bits", () => {
  const weak = keys(2048);
  assert.throws(
    () => verifyPublicationKeyPair(weak.publicKey, weak.privateKey),
    /missing, invalid, or mismatched/
  );
});

test("publication key validation never runs on pull-request-controlled code", async () => {
  const source = await readFile(".github/workflows/publication-key-verify.yml", "utf8");
  const workflow = parse(source) as {
    on: Record<string, unknown>;
    jobs: Record<
      string,
      {
        environment?: string;
        needs?: string;
        steps: Array<{ name?: string; env?: Record<string, string> }>;
      }
    >;
  };
  assert.ok(workflow.on.push);
  const paths = (workflow.on.push as { paths: string[] }).paths;
  assert.ok(paths.includes("scripts/prepare-publication-keys.ts"));
  assert.ok(paths.includes("docs/task-publication-keys.md"));
  assert.equal(workflow.on.workflow_dispatch, undefined);
  assert.equal(workflow.on.pull_request, undefined);
  const unprotected = workflow.jobs["unprotected-scope"];
  const protectedPair = workflow.jobs["protected-pair"];
  assert.ok(unprotected);
  assert.ok(protectedPair);
  assert.equal(unprotected.environment, undefined);
  assert.deepEqual(protectedPair.environment, { name: "admin-ops", deployment: false });
  assert.equal(protectedPair.needs, "unprotected-scope");
  assert.equal(
    unprotected.steps[0]?.env?.PUBLICATION_KEY_LEAKED,
    "${{ secrets.AW_PUBLICATION_PRIVATE_KEY != '' }}"
  );
  const step = protectedPair.steps.find(
    (item) => item.name === "Verify publication keys without exposing material"
  );
  assert.equal(step?.env?.AW_PUBLICATION_PUBLIC_KEY, "${{ vars.AW_PUBLICATION_PUBLIC_KEY }}");
  assert.equal(step?.env?.AW_PUBLICATION_PRIVATE_KEY, "${{ secrets.AW_PUBLICATION_PRIVATE_KEY }}");
  assert.doesNotMatch(source, /toJSON\s*\(\s*secrets\s*\)/);
});

test("trusted main preflight checks a single publication App writer in a protected job", async () => {
  const source = await readFile(".github/workflows/publication-key-verify.yml", "utf8");
  const workflow = parse(source) as {
    on: Record<string, unknown>;
    jobs: Record<
      string,
      {
        environment?: string;
        needs?: string;
        if?: string;
        steps: Array<{
          name?: string;
          uses?: string;
          with?: Record<string, string>;
          env?: Record<string, string>;
        }>;
      }
    >;
  };
  const publisher = workflow.jobs["publication-app"];
  assert.ok(publisher);
  assert.deepEqual(publisher.environment, { name: "admin-ops", deployment: false });
  assert.equal(publisher.needs, "protected-pair");
  assert.equal(publisher.if, "github.ref == 'refs/heads/main'");
  assert.equal(workflow.on.workflow_dispatch, undefined);
  assert.equal(workflow.on.pull_request, undefined);
  const mint = publisher.steps.find(
    (step) => step.name === "Mint strictly scoped publication token"
  );
  assert.equal(mint?.with?.["permission-contents"], "write");
  assert.equal(mint?.with?.["permission-pull-requests"], "write");
  assert.equal(mint?.with?.repositories, "${{ vars.AW_PUBLICATION_TEST_REPOSITORY || 'mcp-hub' }}");
  assert.ok(
    publisher.steps.some((step) => step.name === "Verify token has one authorized repository")
  );
});

test("production keys perform a real encrypted artifact round-trip between clean runners", async () => {
  const source = await readFile(".github/workflows/publication-key-verify.yml", "utf8");
  const workflow = parse(source) as {
    on: Record<string, unknown>;
    jobs: Record<
      string,
      {
        environment?: string;
        needs?: string | string[];
        if?: string;
        steps: Array<{ name?: string; env?: Record<string, string>; uses?: string }>;
      }
    >;
  };
  assert.equal(workflow.on.workflow_dispatch, undefined);
  const sealer = workflow.jobs["smoke-seal"];
  const opener = workflow.jobs["smoke-open"];
  assert.ok(sealer);
  assert.ok(opener);
  assert.equal(sealer.environment, undefined);
  assert.equal(sealer.needs, "unprotected-scope");
  assert.deepEqual(opener.environment, { name: "admin-ops", deployment: false });
  assert.deepEqual(opener.needs, ["protected-pair", "smoke-seal"]);
  assert.equal(opener.if, "github.ref == 'refs/heads/main'");
  assert.equal(
    sealer.steps.some((step) => step.env?.AW_PUBLICATION_PRIVATE_KEY !== undefined),
    false
  );
  assert.equal(
    opener.steps.find((step) => step.name === "Prove request-binding rejection and decrypt")?.env
      ?.AW_PUBLICATION_PRIVATE_KEY,
    "${{ secrets.AW_PUBLICATION_PRIVATE_KEY }}"
  );
  assert.ok(source.includes("Ciphertext accepted a different request identity."));
  assert.ok(source.includes("Plaintext reached the transfer artifact."));
});

test("protected App preflight validates the actual private-source publication target", async () => {
  const source = await readFile(".github/workflows/publication-key-verify.yml", "utf8");
  const flow = parse(source) as {
    jobs: Record<
      string,
      {
        environment?: string;
        steps: Array<{
          name?: string;
          uses?: string;
          with?: Record<string, string>;
          env?: Record<string, string>;
        }>;
      }
    >;
  };
  const job = flow.jobs["publication-app"];
  assert.deepEqual(job?.environment, { name: "admin-ops", deployment: false });
  const step = job.steps.find(
    (item) => item.name === "Verify private source and output target publication policy"
  );
  assert.equal(step?.env?.TARGET_REPOSITORY, "${{ github.repository_owner }}/external-vault");
  const mint = job.steps.find((item) => item.name === "Mint real publication target App token");
  assert.equal(mint?.with?.repositories, "external-vault");
  assert.equal(mint?.with?.["permission-contents"], "write");
  assert.equal(mint?.with?.["permission-pull-requests"], "write");
  assert.ok(job.steps.some((item) => item.name === "Verify real publication target App isolation"));
});

test("one-time governed canary needs an explicit main-commit marker", async () => {
  const source = await readFile(".github/workflows/publication-key-verify.yml", "utf8");
  const flow = parse(source) as {
    jobs: Record<
      string,
      {
        environment?: string;
        steps: Array<{
          name?: string;
          if?: string;
          with?: Record<string, string>;
        }>;
      }
    >;
  };
  const job = flow.jobs["smoke-open"];
  assert.ok(job);
  assert.deepEqual(job.environment, { name: "admin-ops", deployment: false });
  const publisher = job.steps.find(
    (step) => step.name === "Publish canary through central PR governance"
  );
  assert.match(publisher?.if ?? "", /publication-pr-canary/);
  const token = job.steps.find((step) => step.name === "Mint one-time canary target token");
  assert.equal(token?.with?.repositories, "external-vault");
  assert.equal(token?.with?.["permission-contents"], "write");
  assert.equal(token?.with?.["permission-pull-requests"], "write");
  assert.match(source, /Governed canary merged after all three required verdicts/);
  assert.match(source, /Central governance rejected canary; PR left open for inspection/);
  assert.doesNotMatch(source, /\\\\\$\\\{\\\{/);
});
