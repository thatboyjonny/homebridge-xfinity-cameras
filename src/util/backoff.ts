/** Exponential backoff with full jitter, capped. attempt starts at 0. */
export function backoffMs(attempt: number, baseMs = 2_000, capMs = 5 * 60_000, random = Math.random): number {
  const ceiling = Math.min(capMs, baseMs * 2 ** Math.min(attempt, 20));
  return Math.round(ceiling / 2 + random() * (ceiling / 2));
}

export const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) {
      return resolve();
    }
    const t = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener('abort', done);
      clearTimeout(t);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
