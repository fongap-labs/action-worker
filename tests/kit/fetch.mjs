// Runs `fn` with globalThis.fetch replaced by `handler`; always restores it.
/**
 * @template T
 * @param {typeof fetch} handler
 * @param {() => T | Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withMockFetch(handler, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}
