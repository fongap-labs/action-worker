
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { targetRoot } from '#kit/target.mjs';

const ATTEMPT_MODULES = new Set([
  'observability',
  'outcome',
  'success',
  'success-stream',
  'success-object',
  'dispatch',
  'inference-dispatch',
  'generation-dispatch',
  'hedge',
]);

export function readAttemptOwner(name) {
  assert.ok(ATTEMPT_MODULES.has(name), `Unexpected attempt ownership contract: ${name}`);
  const legacyPath = join(targetRoot, 'src', 'request', 'attempt', `${name}.ts`);
  const ownerPath = join(targetRoot, 'apps', 'gateway', 'attempt', `${name}.ts`);
  const legacy = readFileSync(legacyPath, 'utf8');
  const forwarding = `export * from '../../../apps/gateway/attempt/${name}.ts';`;

  if (!existsSync(ownerPath)) {
    assert.doesNotMatch(legacy, /^export \* from ['"][^'"]+['"];?$/m, `${name}: missing implementation behind a legacy export`);
    return legacy;
  }

  const executableLines = legacy
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('//'));
  assert.deepEqual(executableLines, [forwarding], `${name}: legacy path must only export its unique Gateway owner`);

  const owner = readFileSync(ownerPath, 'utf8');
  assert.doesNotMatch(owner, /^export \* from ['"][^'"]+['"];?$/m, `${name}: Gateway owner must implement, not forward`);
  return owner;
}
