import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveBootstrapModel } from "../scripts/resolve-bootstrap-model.ts";

const config = JSON.stringify({
  schema_version: 1,
  agents: {
    review: {
      enabled: true,
      model: "Audit-Pro",
      routes: {
        architecture: { model: "Audit-Ultra" },
      },
    },
  },
});

test("AI Gateway bootstrap uses the centrally authorized architecture route", () => {
  assert.equal(
    resolveBootstrapModel("fongap-labs/ai-gateway", "fongap-labs", config),
    "Audit-Ultra",
  );
});

test("other repositories preserve automatic model routing", () => {
  assert.equal(
    resolveBootstrapModel("fongap-labs/delta-suite", "fongap-labs", ""),
    "auto",
  );
});

test("AI Gateway bootstrap fails closed when the architecture route is unavailable", () => {
  assert.throws(
    () => resolveBootstrapModel(
      "fongap-labs/ai-gateway",
      "fongap-labs",
      JSON.stringify({
        schema_version: 1,
        agents: {
          review: { enabled: true, model: "Audit-Pro", routes: {} },
        },
      }),
    ),
    /review\\.routes\\.architecture/i,
  );
});
