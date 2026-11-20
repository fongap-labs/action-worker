#!/usr/bin/env node
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { targetPath } from '#kit/target.mjs';

const { synchronizeRuntimeSecrets } = await import(
  pathToFileURL(targetPath('scripts/sync-runtime-secrets.mjs')).href
);

const workers = ['ai-gateway', 'ai-inference-center', 'ai-perception-center', 'ai-generation-center'];
const names = [
  'AIG_INFERENCE_AUTH_KEY',
  'AIG_PERCEPTION_AUTH_KEY',
  'AIG_GENERATION_AUTH_KEY',
];
const env = {
  CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
  CLOUDFLARE_API_TOKEN: 'mock-cloudflare-token',
  AIG_INFERENCE_AUTH_KEY: 'i'.repeat(40),
  AIG_PERCEPTION_AUTH_KEY: 'p'.repeat(40),
  AIG_GENERATION_AUTH_KEY: 'g'.repeat(40),
  AIG_TIER1_CREDENTIALS_01: JSON.stringify({
    'inference-node': 'mock-inference-provider-key',
    'perception-node': 'mock-perception-provider-key',
    'generation-node': 'mock-generation-provider-key',
  }),
};
const configurations = Object.fromEntries(
  ['inference', 'perception', 'generation'].map((center) => [
    'ai-' + center + '-center',
    {
      name: 'ai-' + center + '-center',
      vars: { AIG_TIER1_NODES_01: JSON.stringify([{ id: center + '-node' }]) },
    },
  ]),
);

function mockCloudflare({ acknowledge = true, persist = true } = {}) {
  const inventory = new Map(workers.map((worker) => [worker, new Set()]));
  const calls = [];
  async function fetcher(url, options = {}) {
    const parsed = new URL(url);
    assert.equal(parsed.origin, 'https://api.cloudflare.com');
    const match = parsed.pathname.match(/\/workers\/scripts\/([^/]+)\/(secrets|secrets-bulk)$/);
    assert.ok(match, 'Secret API path must be scoped to an approved Worker');
    const [, worker, path] = match;
    assert.ok(workers.includes(worker));
    const method = options.method ?? 'GET';
    calls.push({ worker, method, path });
    let result;
    if (method === 'GET') {
      assert.equal(path, 'secrets');
      result = [...inventory.get(worker)].map((name) => ({ name, type: 'secret_text' }));
    } else if (method === 'PATCH') {
      assert.equal(path, 'secrets-bulk', 'single-Secret version writes are forbidden');
      const body = JSON.parse(options.body);
      const entries = Object.entries(body.secrets);
      assert.ok(entries.length > 0 && entries.length <= 100);
      result = Object.fromEntries(entries.map(([name, item]) => {
        assert.deepEqual(Object.keys(item).sort(), ['name', 'text', 'type']);
        assert.equal(item.name, name);
        assert.equal(item.type, 'secret_text');
        assert.equal(typeof item.text, 'string');
        if (persist) inventory.get(worker).add(name);
        return [name, { name, type: 'secret_text' }];
      }));
      if (!acknowledge && worker === 'ai-gateway') delete result[names[0]];
    } else {
      assert.fail('Only read and one bulk PATCH per Worker are permitted');
    }
    return new Response(JSON.stringify({ success: true, result }), { status: 200 });
  }
  return { fetcher, calls, inventory };
}

const good = mockCloudflare();
const result = await synchronizeRuntimeSecrets(env, good.fetcher, configurations);
assert.deepEqual(result, { workers: 4, bindings: 9 });
assert.equal(good.calls.filter((call) => call.method === 'PATCH').length, 4);
assert.equal(good.calls.filter((call) => call.method === 'PUT').length, 0);
for (const worker of workers) {
  assert.equal(good.calls.filter((call) => call.worker === worker && call.method === 'PATCH').length, 1);
}
assert.deepEqual([...good.inventory.get('ai-gateway')].sort(), names.slice().sort());
for (const worker of workers.slice(1)) {
  assert.equal(good.inventory.get(worker).size, 2);
}

const unconfirmed = mockCloudflare({ acknowledge: false });
await assert.rejects(
  synchronizeRuntimeSecrets(env, unconfirmed.fetcher, configurations),
  /did not confirm the ai-gateway Secret batch update/,
);

const missing = mockCloudflare({ persist: false });
await assert.rejects(
  synchronizeRuntimeSecrets(env, missing.fetcher, configurations),
  /did not retain ai-gateway Secret metadata/,
);
assert.equal(missing.calls.filter((call) => call.method === 'PUT').length, 0);
assert.equal(missing.calls.filter((call) => call.worker === 'ai-gateway' && call.method === 'PATCH').length, 1);
console.log('Cloudflare batch Secret reconciliation: grouped PATCH, evidence verification, fail-closed cases passed.');
