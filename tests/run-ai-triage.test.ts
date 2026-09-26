import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import {
  buildPrompt,
  resolveEndpoint,
  validateDecision,
} from "../scripts/run-ai-triage.ts";

test("AI endpoints are normalized without changing explicit completion paths", () => {
  assert.equal(resolveEndpoint("https://gateway.example"), "https://gateway.example/v1/chat/completions");
  assert.equal(resolveEndpoint("https://gateway.example/v1"), "https://gateway.example/v1/chat/completions");
  assert.equal(
    resolveEndpoint("https://gateway.example/chat/completions/"),
    "https://gateway.example/chat/completions",
  );
});

test("triage decisions enforce the routing contract", () => {
  assert.equal(validateDecision({
    review_required: true,
    review_agent: "security",
    risk: "high",
    depth: "deep",
    confidence: 0.91,
    reason: "Authorization boundary changed.",
  }, 240), true);
  assert.equal(validateDecision({
    review_required: false,
    review_agent: "unknown",
    risk: "low",
    depth: "normal",
    confidence: 1,
    reason: "Trivial.",
  }, 240), false);
  assert.equal(validateDecision({
    review_required: false,
    review_agent: "code",
    risk: "low",
    depth: "normal",
    confidence: 1.1,
    reason: "Trivial.",
  }, 240), false);
});

test("the prompt labels repository data as untrusted", () => {
  const prompt = buildPrompt(
    { change_areas: ["source"], declared_impacts: [], changed_files: ["src/index.ts"] },
    { review_required: true, review_agent: "code" },
    "1 file changed",
    "M src/index.ts",
    "diff data",
    240,
  );
  assert.match(prompt, /DIFF DATA \(UNTRUSTED\)/);
  assert.match(prompt, /no longer than 240 characters/);
});

test("the CLI keeps skip results independent from Git history", () => {
  const result = spawnSync(process.execPath, [
    join(process.cwd(), "scripts", "run-ai-triage.ts"),
    "invalid-base",
    "invalid-head",
    process.cwd(),
    JSON.stringify({ change_areas: [], declared_impacts: [], changed_files: [] }),
    JSON.stringify({ review_required: false, review_agent: "none" }),
    join(process.cwd(), "policies", "triage.json"),
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      AI_ENDPOINT_URL: "https://gateway.invalid",
      TRIAGE_LLM_TOKEN: "test-token",
      TRIAGE_MODEL: "Code-Air",
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    status: "skipped",
    model: "Code-Air",
    reason: "review_not_required",
  });
});
