import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyPinnedCheckout } from "../scripts/verify-ci-checkout.ts";

const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);
const mergeSha = "c".repeat(40);

test("PR checkout accepts the exact pinned merge commit and ordered parents", () => {
  assert.doesNotThrow(() =>
    verifyPinnedCheckout({
      prNumber: "42",
      baseSha,
      headSha,
      mergeSha,
      checkedOutSha: mergeSha,
      parents: [baseSha, headSha],
    })
  );
});

test("PR checkout rejects a mutable-ref race that checks out another merge commit", () => {
  assert.throws(
    () =>
      verifyPinnedCheckout({
        prNumber: "42",
        baseSha,
        headSha,
        mergeSha,
        checkedOutSha: "d".repeat(40),
        parents: [baseSha, headSha],
      }),
    /different merge commit/
  );
});

test("PR checkout rejects merge commits built from a different base or head", () => {
  assert.throws(
    () =>
      verifyPinnedCheckout({
        prNumber: "42",
        baseSha,
        headSha,
        mergeSha,
        checkedOutSha: mergeSha,
        parents: [ "e".repeat(40), headSha ],
      }),
    /parents do not match/
  );
});

test("branch CI requires the exact requested head", () => {
  assert.doesNotThrow(() =>
    verifyPinnedCheckout({
      prNumber: "0",
      baseSha: "",
      headSha,
      mergeSha: "",
      checkedOutSha: headSha,
      parents: [baseSha],
    })
  );
  assert.throws(
    () =>
      verifyPinnedCheckout({
        prNumber: "0",
        baseSha: "",
        headSha,
        mergeSha: "",
        checkedOutSha: "f".repeat(40),
        parents: [baseSha],
      }),
    /different commit/
  );
});
