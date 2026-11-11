/** Preserve Node's timer semantics for Github API and CI polling waits. */
export function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}
