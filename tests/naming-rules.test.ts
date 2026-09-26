import assert from "node:assert/strict";
import { test } from "node:test";

import { commandFailureMessage } from "../scripts/validate-naming-rules.ts";

test("source naming command failures preserve their diagnostic message", () => {
  assert.equal(
    commandFailureMessage(new Error("source naming violations:\n  crates/example.rs: invalid name")),
    "source naming violations:\n  crates/example.rs: invalid name",
  );
  assert.equal(commandFailureMessage("plain failure"), "plain failure");
});
