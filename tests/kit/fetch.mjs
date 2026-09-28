// Runs `fn` with globalThis.fetch replaced by `handler`; always restores it.
export async function withMockFetch(handler, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}
