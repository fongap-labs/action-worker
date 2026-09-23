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
    writing: {
      enabled: true,
      model: "Editor-Air",
      routes: {},
    },
  },
});

test("AI Gateway bootstrap uses the centrally configured independent model", () => {
  assert.equal(
    resolveBootstrapModel("fongap-labs/ai-gateway", "fongap-labs", config),
    "Editor-Air",
  );
});

test("other repositories preserve automatic model routing", () => {
  assert.equal(
    resolveBootstrapModel("fongap-labs/delta-suite", "fongap-labs", ""),
    "auto",
  );
});

test("AI Gateway bootstrap fails closed when the independent model is unavailable", () => {
  assert.throws(
    () => resolveBootstrapModel(
      "fongap-labs/ai-gateway",
      "fongap-labs",
      JSON.stringify({
        schema_version: 1,
        agents: {
          review: { enabled: true, model: "Audit-Pro", routes: { architecture: { model: "Audit-Ultra" } } },
          writing: { enabled: false, model: "Editor-Air", routes: {} },
        },
      }),
    ),
    /agents\.writing\.model/i,
  );
});
