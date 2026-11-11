// SPDX-License-Identifier: MIT
// Black-box Perception routing, center isolation, and protected release tests.
import { afterEach, assert, beforeEach, test } from "#kit/harness.mjs";
import { readFileSync } from "node:fs";
import { targetPath } from "#kit/target.mjs";
import worker from "#target/src/index.ts";
import { buildExecutionHeaders } from "#target/packages/contracts/execution.ts";
import { handlePerceptionCenterRequest } from "#target/src/perception/perception-center-entry.ts";
import { handleInferenceCenterRequest } from "#target/src/inference/inference-center-entry.ts";
import { hasImageInput } from "#target/packages/contracts/image-input.ts";
import {
  __resetAllStateForTests,
} from "#target/src/reliability/node-state.ts";
import {
  __resetTier1StateForTests,
} from "#target/src/reliability/tier1-state.ts";
import { buildPrivateCenterConfig, verifyPrivateCenterSecretNames } from "#target/scripts/private-center-config.mjs";

const ACCESS_KEY = "perception-test-access-key";
const PERCEPTION_KEY = "perception-center-private-auth-key-0123456789";
const INFERENCE_KEY = "inference-center-private-auth-key-0123456789";
const NODE_ID = "vision-node";
const MODEL = "vision-model";
const IMAGE = "data:image/png;base64,aGVsbG8=";
const modelCatalog = JSON.stringify({
  [MODEL]: {
    policy: "default",
    capabilities: { vision: true },
    modalities: { input: ["text", "image"], output: ["text"] },
  },
});
const policies = "{}";
const node = {
  id: NODE_ID,
  provider: "openai",
  base_url: "https://provider.example/v1",
  models: { [MODEL]: "upstream-vision-model" },
};
const ctx = { waitUntil(promise) { Promise.resolve(promise).catch(() => {}); } };
const originalFetch = globalThis.fetch;
let providerCalls;

function request(body, path = "/v1/chat/completions") {
  return new Request(`https://gateway.example${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${ACCESS_KEY}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function imageChatBody() {
  return {
    model: MODEL,
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "Describe this picture." },
        { type: "image_url", image_url: { url: IMAGE } },
      ],
    }],
  };
}

test("image admission recognizes only the supported Chat, Responses, and Messages image shapes", () => {
  assert.equal(hasImageInput(imageChatBody()), true);
  assert.equal(hasImageInput({
    model: MODEL,
    input: [{ type: "message", role: "user", content: [{ type: "input_image", image_url: IMAGE }] }],
  }), true);
  assert.equal(hasImageInput({
    model: MODEL,
    messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } }] }],
  }), true);
  assert.equal(hasImageInput({ input: [{ type: "input_image", file_id: "file_123" }] }), true);
  assert.equal(hasImageInput({ input: [{ type: "input_audio", audio: "aGVsbG8=" }] }), false);
  assert.equal(hasImageInput({ input: [{ type: "input_video", video_url: "https://example.test/video.mp4" }] }), false);
});

function centerEnv(authName, authKey, providerNode = node) {
  return {
    [authName]: authKey,
    AIG_MODELS_CONFIG: modelCatalog,
    AIG_POLICIES_CONFIG: policies,
    AIG_TIER1_NODES_01: JSON.stringify([providerNode]),
    AIG_TIER1_CREDENTIALS_01: JSON.stringify({ [providerNode.id]: "provider-test-secret" }),
  };
}

function gatewayEnv(providerNode = node) {
  const perception = centerEnv("AIG_PERCEPTION_AUTH_KEY", PERCEPTION_KEY, providerNode);
  const inference = centerEnv("AIG_INFERENCE_AUTH_KEY", INFERENCE_KEY, providerNode);
  const env = {
    AIG_ACCESS_KEY_AIR: ACCESS_KEY,
    AIG_ACCESS_MODELS_AIR: "*",
    AIG_MODELS_CONFIG: modelCatalog,
    AIG_POLICIES_CONFIG: policies,
    AIG_TIER1_NODES_01: JSON.stringify([providerNode]),
    AIG_PERCEPTION_AUTH_KEY: PERCEPTION_KEY,
    AIG_INFERENCE_AUTH_KEY: INFERENCE_KEY,
    AIG_PERCEPTION_SERVICE: {
      fetch(request) {
        assert.equal(request.headers.get("x-aig-perception-auth"), PERCEPTION_KEY);
        assert.equal(request.headers.get("x-aig-inference-auth"), null);
        assert.equal(request.headers.get("authorization"), null);
        return handlePerceptionCenterRequest(request, perception);
      },
    },
    AIG_INFERENCE_SERVICE: {
      fetch(request) {
        assert.equal(request.headers.get("x-aig-inference-auth"), INFERENCE_KEY);
        assert.equal(request.headers.get("x-aig-perception-auth"), null);
        assert.equal(request.headers.get("authorization"), null);
        return handleInferenceCenterRequest(request, inference);
      },
    },
  };
  return env;
}

beforeEach(() => {
  __resetAllStateForTests();
  __resetTier1StateForTests();
  providerCalls = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    const headers = init?.headers instanceof Headers ? init.headers : new Headers(init?.headers);
    const body = init?.body == null ? null : JSON.parse(String(init.body));
    providerCalls.push({ url, headers, body });
    return Response.json({
      id: "chatcmpl-perception-test",
      object: "chat.completion",
      model: "upstream-vision-model",
      choices: [{ index: 0, message: { role: "assistant", content: "A test image." }, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 },
    });
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("declared vision image requests use the distinct private Perception binding", async () => {
  const env = gatewayEnv();
  const response = await worker.fetch(request(imageChatBody()), env, ctx);
  assert.equal(response.status, 200);
  assert.equal(providerCalls.length, 1);
  assert.equal(providerCalls[0].url.pathname, "/v1/chat/completions");
  assert.equal(providerCalls[0].headers.get("authorization"), "Bearer provider-test-secret");
  assert.deepEqual(providerCalls[0].body.messages[0].content[1], {
    type: "image_url",
    image_url: { url: IMAGE },
  });
  assert.equal(Object.hasOwn(env, "AIG_TIER1_CREDENTIALS_01"), false);
});

test("a vision model text request stays on Inference and preserves the existing provider path", async () => {
  const env = gatewayEnv();
  const body = { model: MODEL, messages: [{ role: "user", content: "Hello." }] };
  const response = await worker.fetch(request(body), env, ctx);
  assert.equal(response.status, 200);
  assert.equal(providerCalls.length, 1);
  assert.equal(providerCalls[0].body.messages[0].content, "Hello.");
});

test("an image request with no vision catalog declaration is rejected before either center", async () => {
  const env = gatewayEnv();
  env.AIG_MODELS_CONFIG = JSON.stringify({ [MODEL]: { policy: "default" } });
  const response = await worker.fetch(request(imageChatBody()), env, ctx);
  assert.equal(response.status, 400);
  assert.equal(providerCalls.length, 0);
});

test("a Google Gemini vision model can receive image input through private Perception", async () => {
  const googleNode = { ...node, provider: "google" };
  const env = gatewayEnv(googleNode);
  const response = await worker.fetch(request(imageChatBody()), env, ctx);
  assert.equal(response.status, 200);
  assert.equal(providerCalls.length, 1);
  assert.equal(providerCalls[0].url.pathname, "/v1/chat/completions");
});

test("an image request skips providers without an explicit image-input contract", async () => {
  const env = gatewayEnv();
  env.AIG_TIER1_NODES_01 = JSON.stringify([{ ...node, provider: "unknown-custom-provider" }]);
  const response = await worker.fetch(request(imageChatBody()), env, ctx);
  assert.notEqual(response.status, 200);
  assert.equal(providerCalls.length, 0);
});

test("a missing Perception binding fails closed without retrying through Inference", async () => {
  const env = gatewayEnv();
  delete env.AIG_PERCEPTION_SERVICE;
  const response = await worker.fetch(request(imageChatBody()), env, ctx);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.details.gateway_code, "gateway_perception_center_unavailable");
  assert.equal(providerCalls.length, 0);
});

test("the private Perception center rejects a model without an explicit vision declaration before Provider dispatch", async () => {
  const key = PERCEPTION_KEY;
  const requestBody = imageChatBody();
  const headers = buildExecutionHeaders({
    requestId: "123e4567-e89b-42d3-a456-426614174000",
    nodeId: NODE_ID,
    logicalModel: MODEL,
    surface: "chat_completions",
    deadlineMs: Date.now() + 60_000,
  }, "x-aig-perception-auth", key);
  const privateRequest = new Request("https://perception.internal/internal/execute", {
    method: "POST",
    headers,
    body: JSON.stringify(requestBody),
  });
  const env = {
    ...centerEnv("AIG_PERCEPTION_AUTH_KEY", key),
    AIG_MODELS_CONFIG: JSON.stringify({ [MODEL]: { policy: "default" } }),
  };
  const response = await handlePerceptionCenterRequest(privateRequest, env);
  assert.equal(response.status, 404);
  assert.equal(response.headers.get("x-aig-result"), "skipped");
  assert.equal(providerCalls.length, 0);
});

test("private Perception config contains only explicitly vision-enabled models on image-input providers", () => {
  const sourceSha = "a".repeat(40);
  const inputs = {
    DEPLOY_SOURCE_SHA: sourceSha,
    AIG_MODELS_CONFIG: JSON.stringify({
      [MODEL]: { capabilities: { vision: true }, modalities: { input: ["text", "image"], output: ["text"] } },
      "text-model": { capabilities: { vision: false }, modalities: { input: ["text"], output: ["text"] } },
    }),
    AIG_POLICIES_CONFIG: policies,
    AIG_TIER1_NODES_01: JSON.stringify([{
      id: NODE_ID,
      provider: "openai",
      base_url: "https://provider.example/v1",
      models: { [MODEL]: "upstream-vision-model", "text-model": "upstream-text-model" },
    }]),
  };
  const built = buildPrivateCenterConfig("ai-perception-center", inputs);
  assert.equal(built.config.name, "ai-perception-center");
  assert.equal(built.config.workers_dev, false);
  assert.deepEqual(built.config.vars.AIG_TIER1_NODES_01, JSON.stringify([{
    id: NODE_ID,
    provider: "openai",
    base_url: "https://provider.example/v1",
    models: { [MODEL]: "upstream-vision-model" },
  }]));
  assert.deepEqual(JSON.parse(built.config.vars.AIG_MODELS_CONFIG), {
    [MODEL]: { capabilities: { vision: true }, modalities: { input: ["text", "image"], output: ["text"] } },
  });
  const googleInputs = {
    ...inputs,
    AIG_TIER1_NODES_01: JSON.stringify([{
      id: NODE_ID,
      provider: "google",
      base_url: "https://provider.example/v1",
      models: { [MODEL]: "upstream-vision-model", "text-model": "upstream-text-model" },
    }]),
  };
  const googleBuilt = buildPrivateCenterConfig("ai-perception-center", googleInputs);
  assert.equal(googleBuilt.nodeCount, 1);
  assert.deepEqual(JSON.parse(googleBuilt.config.vars.AIG_TIER1_NODES_01), [{
    id: NODE_ID,
    provider: "google",
    base_url: "https://provider.example/v1",
    models: { [MODEL]: "upstream-vision-model" },
  }]);
  assert.equal(built.config.routes, undefined);
  assert.equal(built.config.services, undefined);
  assert.deepEqual(
    verifyPrivateCenterSecretNames("ai-perception-center", [
      { name: "AIG_PERCEPTION_AUTH_KEY", type: "secret_text" },
      { name: "AIG_TIER1_CREDENTIALS_01", type: "secret_text" },
    ], ["1"]),
    { worker: "ai-perception-center", secretNames: 2, tierCount: 1 },
  );
  assert.throws(() => buildPrivateCenterConfig("ai-perception-center", {
    ...inputs,
    AIG_MODELS_CONFIG: JSON.stringify({ "text-model": { capabilities: { vision: false } } }),
  }), /no eligible node/i);
});

test("one source deployment prepares all three private centers before Gateway publication", () => {
  const deploy = readFileSync(targetPath("scripts/deploy.sh"), "utf8").replace(/\r\n/g, "\n");
  assert.match(deploy, /for center in ai-inference-center ai-perception-center ai-generation-center/);
  const firstCenterPublish = deploy.indexOf('action-worker:center:$center:$DEPLOY_SOURCE_SHA');
  const gatewayPublish = deploy.indexOf('action-worker:deploy:$DEPLOY_SOURCE_SHA');
  const firstInventoryCheck = deploy.indexOf('private-center-config.mjs verify-inventory');
  assert.ok(firstCenterPublish >= 0 && gatewayPublish > firstCenterPublish);
  assert.ok(firstInventoryCheck > firstCenterPublish && gatewayPublish > firstInventoryCheck);
  assert.match(deploy, /deployment-recovery\.mjs snapshot/);
  assert.doesNotMatch(deploy, /--secrets-file|gateway-secrets\.json/);
});
