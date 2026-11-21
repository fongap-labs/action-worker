import { assert, test } from '#kit/harness.mjs';
import { withMockFetch } from '#kit/fetch.mjs';
import { handleInferenceCenterRequest } from '#target/src/inference/inference-center-entry.ts';
import { __resetAllStateForTests } from '#target/src/reliability/node-state.ts';
import { __resetTier1StateForTests } from '#target/src/reliability/tier1-state.ts';
import worker from '#target/src/index.ts';
import { inferMirroredModelSiblings } from '#target/apps/gateway/policy/automatic-model-family.ts';
import { buildModelFallbackRounds, buildModelFallbackPlan } from '#target/src/request/model-fallback.ts';

const catalog = new Set([
  'Pro', 'Max', 'Ultra',
  'Code-Pro', 'Code-Max', 'Code-Ultra',
  'Omni', 'Image-Creator', 'Standalone',
]);

test('inferred sibling recovery works without AIG_MODELS_CONFIG or model-specific rules', () => {
  assert.deepEqual(inferMirroredModelSiblings('Code-Ultra', catalog), ['Code-Pro', 'Code-Max']);
  assert.deepEqual(inferMirroredModelSiblings('Ultra', catalog), ['Pro', 'Max']);
  assert.deepEqual(buildModelFallbackRounds('Code-Ultra', catalog), [['Code-Ultra', 'Code-Pro', 'Code-Max']]);
  assert.deepEqual(buildModelFallbackRounds('Ultra', catalog), [['Ultra', 'Pro', 'Max']]);
  assert.deepEqual(buildModelFallbackRounds('Omni', catalog), [['Omni']]);
  assert.deepEqual(buildModelFallbackRounds('Image-Creator', catalog), [['Image-Creator']]);
  assert.deepEqual(buildModelFallbackRounds('Standalone', catalog), [['Standalone']]);
});

test('inference requires three mirrored tiers and never bridges namespaces', () => {
  const oneNamespace = new Set(['Draft-Pro', 'Draft-Max', 'Draft-Ultra', 'Omni']);
  assert.deepEqual(inferMirroredModelSiblings('Draft-Ultra', oneNamespace), []);
  const twoMirrored = new Set(['Pro', 'Max', 'Ultra', 'Draft-Pro', 'Draft-Max']);
  assert.deepEqual(inferMirroredModelSiblings('Draft-Pro', twoMirrored), []);
  const crossed = new Set(['Core-A', 'Core-B', 'Core-C', 'Review-A', 'Review-B', 'Review-C']);
  assert.deepEqual(inferMirroredModelSiblings('Core-C', crossed), ['Core-A', 'Core-B']);
  assert.equal(inferMirroredModelSiblings('Core-C', crossed).some((name) => name.startsWith('Review-')), false);
});

test('explicit fallback and empty opt-out override inference', () => {
  const optedOut = { 'Code-Ultra': { policy: { fallback: [] } } };
  assert.deepEqual(buildModelFallbackRounds('Code-Ultra', catalog, optedOut), [['Code-Ultra']]);
  const explicit = { 'Code-Ultra': { policy: { fallback: ['Omni'], fallback_mode: 'one_way' } } };
  assert.deepEqual(buildModelFallbackRounds('Code-Ultra', catalog, explicit), [
    ['Code-Ultra', 'Omni'],
    ['Omni'],
  ]);
});

test('inferred plan is one-way, fairly bounded, and never expands attempt budget', () => {
  const plans = buildModelFallbackPlan('Code-Ultra', catalog, 8);
  assert.equal(plans.length, 1, 'no revisiting previously attempted sibling models');
  const passes = plans[0];
  assert.deepEqual(passes.map((pass) => pass.model), ['Code-Ultra', 'Code-Pro', 'Code-Max']);
  assert.ok(passes.every((pass) => pass.attemptCap >= 1));
  assert.ok(passes.reduce((sum, pass) => sum + pass.attemptCap, 0) <= 8);
  const small = buildModelFallbackPlan('Code-Ultra', catalog, 2);
  assert.equal(small.length, 1);
  assert.ok(small[0].length <= 2, 'planning must not allocate more visible models than attempts');
  assert.ok(small[0].reduce((sum, pass) => sum + pass.attemptCap, 0) <= 2);
});

test('end-to-end Code tier switches to a sibling on 429 with no AIG_MODELS_CONFIG', async () => {
  __resetAllStateForTests();
  __resetTier1StateForTests();
  const names = ['Pro', 'Max', 'Ultra', 'Code-Pro', 'Code-Max', 'Code-Ultra'];
  const nodes = names.map((name, index) => ({
    id: `auto-node-${index}`,
    provider: 'openai',
    base_url: `https://auto-node-${index}.example.com/v1`,
    models: { [name]: `physical-${name.toLowerCase()}` },
  }));
  const credentials = Object.fromEntries(nodes.map((node) => [node.id, `secret-${node.id}`]));
  const centerAuth = 'automatic-sibling-private-center-auth-key';
  const centerEnv = {
    AIG_TIER1_NODES_01: JSON.stringify(nodes),
    AIG_TIER1_CREDENTIALS_01: JSON.stringify(credentials),
    AIG_INFERENCE_AUTH_KEY: centerAuth,
    AIG_PROTOCOL_FALLBACKS: 'disable',
  };
  const gatewayEnv = {
    AIG_ACCESS_KEY_ULTRA: 'unconfigured-family-access-key',
    AIG_ACCESS_MODELS_ULTRA: '*',
    AIG_TIER1_NODES_01: JSON.stringify(nodes),
    AIG_INFERENCE_AUTH_KEY: centerAuth,
    AIG_INFERENCE_ACTIVE: 'true',
    AIG_PROTOCOL_FALLBACKS: 'disable',
    AIG_INFERENCE_SERVICE: {
      fetch(request) {
        assert.equal(request.headers.get('x-aig-inference-auth'), centerAuth);
        return handleInferenceCenterRequest(request, centerEnv);
      },
    },
  };
  assert.equal('AIG_MODELS_CONFIG' in gatewayEnv, false);
  assert.equal('AIG_TIER1_CREDENTIALS_01' in gatewayEnv, false);
  const physical = [];
  const reply = await withMockFetch(async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : await input.clone().text());
    physical.push({ host: url.hostname, model: body.model });
    if (body.model === 'physical-code-ultra') {
      return new Response(JSON.stringify({ error: { message: 'upstream rate limited' } }), {
        status: 429,
        headers: { 'content-type': 'application/json', 'retry-after': '2' },
      });
    }
    return new Response(JSON.stringify({
      id: 'chatcmpl-auto',
      object: 'chat.completion',
      model: body.model,
      choices: [{ index: 0, message: { role: 'assistant', content: 'sibling recovered' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }, () => worker.fetch(new Request('https://gateway.example.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer unconfigured-family-access-key' },
    body: JSON.stringify({ model: 'Code-Ultra', messages: [{ role: 'user', content: 'hello' }] }),
  }), gatewayEnv, { waitUntil() {} }));
  assert.equal(reply.status, 200, 'retry should recover transparently through the inference center');
  const json = await reply.json();
  assert.equal(json.model, 'Code-Ultra', 'client-facing model identity should not be rewritten to a sibling');
  assert.equal(json.choices[0].message.content, 'sibling recovered');
  assert.equal(physical[0].model, 'physical-code-ultra');
  assert.ok(physical.some((attempt) => ['physical-code-pro', 'physical-code-max'].includes(attempt.model)));
  assert.ok(physical.every((attempt) => attempt.model.startsWith('physical-code-')), 'never cross to the general namespace');
});
