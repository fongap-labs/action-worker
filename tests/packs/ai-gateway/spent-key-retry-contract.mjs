import { targetRoot } from '#kit/target.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const requestState = readFileSync(join(targetRoot, 'src/types/request.ts'), 'utf8');
export const legacySpentKeyRetry = requestState.includes('hasRetriedSameNode');
