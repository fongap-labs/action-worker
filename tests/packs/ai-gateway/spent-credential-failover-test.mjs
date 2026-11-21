import { assert, test } from '#kit/harness.mjs';
import { failedDomainNodeIds, rememberFailedDomains } from '#target/apps/gateway/policy/model-fallback.ts';
import { isCredentialWideFailure, preferUntriedCredentials } from '#target/apps/gateway/reliability/retry-budget.ts';

const modelA = 'logical-a';
const modelB = 'logical-b';
const shared = {
  tier: 'tier-1',
  provider: 'provider-generic',
  baseUrl: 'https://upstream.invalid/v1',
  protocol: 'openai',
  surfaces: ['chat_completions'],
  models: { [modelA]: 'physical-a', [modelB]: 'physical-b' },
};
const spent = { ...shared, id: 'slot-a', keyGroup: 'key-a' };
const sameKey = { ...shared, id: 'slot-b', keyGroup: 'key-a' };
const independent = { ...shared, id: 'slot-c', keyGroup: 'key-b' };
const nodes = [spent, sameKey, independent];
const byId = new Map(nodes.map((node) => [node.id, node]));

test('429 and timeout are not replayed against any node using the same credential in one request', () => {
  for (const failure of [
    { kind: 'rate_limit', status: 429, rate_limit_scope: 'model' },
    { kind: 'rate_limit', status: 429, rate_limit_scope: 'account' },
    { kind: 'rate_limit_global', status: 429 },
    { kind: 'headers_timeout', status: 0 },
    { kind: 'first_event_timeout', status: 0 },
    { kind: 'server', status: 504 },
  ]) {
    const attempt = { ...failure, dispatched: true, node_id: spent.id, effective_model: modelA };
    assert.equal(isCredentialWideFailure(attempt), true, `${failure.kind}/${failure.status} must exhaust this Key`);
    const domains = new Set();
    rememberFailedDomains(domains, byId, new Set([spent.id]), modelA, [attempt]);
    const excluded = failedDomainNodeIds(nodes, modelB, domains, 'chat_completions');
    assert.equal(excluded.has(spent.id), true);
    assert.equal(excluded.has(sameKey.id), true, `same Key must not be retried via sibling model: ${failure.kind}/${failure.status}`);
    assert.equal(excluded.has(independent.id), false, 'independent Key remains eligible');
  }
});

test('non-dispatched failures and unrelated server/client statuses do not block all models on a credential', () => {
  for (const failure of [
    { kind: 'rate_limit', status: 429, dispatched: false },
    { kind: 'client', status: 400, dispatched: true },
    { kind: 'server', status: 502, dispatched: true },
  ]) {
    assert.equal(isCredentialWideFailure(failure), false);
  }
});

test('in-pass selection must prefer and permit independent credentials', () => {
  const excluded = preferUntriedCredentials(
    [sameKey, independent],
    nodes,
    [spent.id],
    new Set([spent.id]),
  );
  assert.ok(excluded);
  assert.equal(excluded.has(sameKey.id), true);
  assert.equal(excluded.has(independent.id), false);
});
