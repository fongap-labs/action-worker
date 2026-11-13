// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Migration detection for central test packs pinned by downstream repositories.
// The older Gateway legitimately retries one spent Tier 1 Key after transient
// pool exhaustion; the newer Gateway never replays a spent physical Key merely
// because its logical attempt limit has unused slots.
//
// This feature test selects a strict contract for each immutable target source
// revision. It must not make a failed target pass by inspecting its response.
import { targetRoot } from '#kit/target.mjs';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const requestState = readFileSync(join(targetRoot, 'src/types/request.ts'), 'utf8');
export const legacySpentKeyRetry = requestState.includes('hasRetriedSameNode');

// A later routing contract excludes a failed physical Key across logical-model
// switches, even when those aliases resolve to different upstream models.
// Detect the source contract, not its runtime response, for pinned old targets.
const fallbackPath = join(targetRoot, 'apps/gateway/policy/model-fallback.ts');
export const strictFailedKeyAcrossModels = existsSync(fallbackPath) && readFileSync(fallbackPath, 'utf8').includes('keyFailureDomainKey');
