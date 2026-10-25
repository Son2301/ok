/** Serialises async work per key (e.g. one turn at a time per conversation). */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<unknown>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const tail = prev.then(() => gate);
    this.tails.set(key, tail);
    await prev.catch(() => {});
    try {
      return await fn();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}

/**
 * Fire-and-forget work (webhook processing, wake-ups) that tests and graceful
 * shutdown can wait for with `drain()`.
 */
export class BackgroundTasks {
  private readonly pending = new Set<Promise<unknown>>();
  constructor(private readonly onError: (err: unknown) => void = () => {}) {}

  run(fn: () => Promise<unknown>): void {
    const p = Promise.resolve()
      .then(fn)
      .catch((err) => this.onError(err))
      .finally(() => this.pending.delete(p));
    this.pending.add(p);
  }

  async drain(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  get size(): number {
    return this.pending.size;
  }
}

/** Run `fn` over items with at most `limit` in flight; results keep input order. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}
