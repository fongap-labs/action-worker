import { assert, test } from '#kit/harness.mjs';
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
