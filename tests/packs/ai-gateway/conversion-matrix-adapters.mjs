// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Test-side adapters onto the IR matrix (src/conversion/matrix/). The
// pairwise Chat <-> Messages converters were absorbed into the matrix, so the
// conversion suites drive every cross-protocol path through these helpers
// rather than through per-pair modules that no longer exist.

import { ANTHROPIC_DEFAULT_MAX_TOKENS } from '#target/src/conversion/matrix/anthropic.ts';
import {
  convertMatrixRequest,
  openMatrixStream,
  replyFromNativeObject,
  replyToObject,
} from '#target/src/conversion/matrix/pipeline.ts';

export { ConversionError } from '#target/src/conversion/validation.ts';

export const DEFAULT_MAX_TOKENS = ANTHROPIC_DEFAULT_MAX_TOKENS;

/** Request body in the target protocol. The matrix forces `stream: true` upstream. */
export function convertRequest(from, to, body) {
  return convertMatrixRequest(from, to, body).body;
}

/** Native non-streaming object from one protocol rendered as another. */
export function convertResponse(from, to, data) {
  const { reply } = replyFromNativeObject(from, data);
  return replyToObject(reply, to);
}

/** Full ConversionResult (body, fidelity, diagnostics, structuredOutput) for a matrix pair. */
export function convertResult(from, to, body) {
  return convertMatrixRequest(from, to, body);
}

/** Client-protocol SSE stream decoded from an upstream body (ReadableStream or Response). */
export function convertStream(from, to, upstream, { messageId, onUpstreamUsage, inputTokens } = {}) {
  const body = upstream instanceof Response ? upstream.body : upstream;
  return openMatrixStream(body, from, to, messageId ?? 'resp-test', {
    onUpstreamUsage,
    seedInputTokens: inputTokens,
  }).clientStream;
}

/**
 * Anthropic usage rendered from an OpenAI Chat usage object. Returns null when
 * the usage carries no tokens (missing signal), matching the old helper.
 */
export function convertOpenAIUsageToAnthropic(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const rendered = convertResponse('openai_chat', 'anthropic', { choices: [], usage }).usage;
  if (!rendered || (!rendered.input_tokens && !rendered.output_tokens)) return null;
  return rendered;
}
