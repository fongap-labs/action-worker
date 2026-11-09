// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Resolve the true attempt implementation while keeping central regression
// tests compatible with older pinned AI Gateway commits. Migrated source is
// only allowed when the old entry is a pure compatibility export: a second
// implementation (or a missing owner) is a hard contract failure.

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

  // Comments are allowed for license and migration context, but executable
  // statements, imports, other exports or duplicated implementations are not.
  const executableLines = legacy
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('//'));
  assert.deepEqual(executableLines, [forwarding], `${name}: legacy path must only export its unique Gateway owner`);

  const owner = readFileSync(ownerPath, 'utf8');
  assert.doesNotMatch(owner, /^export \* from ['"][^'"]+['"];?$/m, `${name}: Gateway owner must implement, not forward`);
  return owner;
}
