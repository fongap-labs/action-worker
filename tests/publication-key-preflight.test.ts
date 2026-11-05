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
  assert.equal(workflow.on.pull_request, undefined);
  const unprotected = workflow.jobs["unprotected-scope"];
  const protectedPair = workflow.jobs["protected-pair"];
  assert.ok(unprotected);
  assert.ok(protectedPair);
  assert.equal(unprotected.environment, undefined);
  assert.equal(protectedPair.environment, "admin-ops");
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
