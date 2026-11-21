import { assert, test } from '#kit/harness.mjs';
import { ensureFirstSseEvent } from '#target/src/stream/guard.ts';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function guardedSource(prefixCount = 80) {
  const frames = Array.from({ length: prefixCount }, (_, index) =>
    `event: response.created\ndata: ${JSON.stringify({ type: 'response.created', index, payload: 'x'.repeat(128) })}\n\n`,
  );
  frames.push('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hello"}\n\n');
  frames.push('event: response.completed\ndata: {"type":"response.completed"}\n\n');
  let next = 0;
  let canceled = false;
  return {
    wire: frames.join(''),
    get canceled() { return canceled; },
    response: new Response(
      new ReadableStream(
        {
          pull(controller) {
            if (next === frames.length) {
              controller.close();
              return;
            }
            controller.enqueue(encoder.encode(frames[next++]));
          },
          cancel() { canceled = true; },
        },
        { highWaterMark: 0 },
      ),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ),
  };
}

const isRealOutput = (value) => value?.type === 'response.output_text.delta';

test('the guarded SSE prefix must not be eagerly enqueued before downstream demand', async () => {
  const source = guardedSource(80);
  const NativeReadableStream = globalThis.ReadableStream;
  const guardedStreams = [];
  let guarded;
  try {
    globalThis.ReadableStream = class extends NativeReadableStream {
      constructor(underlyingSource, strategy) {
        if (typeof underlyingSource?.cancel === 'function' && typeof underlyingSource?.pull === 'function') {
          guardedStreams.push({ hasEagerStart: typeof underlyingSource.start === 'function', highWaterMark: strategy?.highWaterMark });
        }
        super(underlyingSource, strategy);
      }
    };
    guarded = await ensureFirstSseEvent(source.response, 5_000, null, isRealOutput);
  } finally {
    globalThis.ReadableStream = NativeReadableStream;
  }
  assert.equal(guardedStreams.length, 1);
  assert.equal(guardedStreams[0].hasEagerStart, false, 'buffered frames must replay only from pull(), never start()');
  assert.equal(guardedStreams[0].highWaterMark, 0, 'an idle consumer must not trigger output prefetch');
  assert.equal(await guarded.text(), source.wire, 'replaying the guard prefix must preserve exact SSE frame bytes');
});

test('the guarded SSE replay preserves chunk order and propagates downstream cancel', async () => {
  const source = guardedSource(40);
  const guarded = await ensureFirstSseEvent(source.response, 5_000, null, isRealOutput);
  const reader = guarded.body.getReader();
  const first = await reader.read();
  assert.equal(first.done, false);
  assert.equal(decoder.decode(first.value), source.wire.split('\n\n')[0] + '\n\n');
  await reader.cancel('downstream stopped');
  assert.equal(source.canceled, true, 'canceling the guarded response releases its upstream reader');
});
