// Per-session-ID mutex for setup RPCs (fork / load / resume).
//
// Turn claims only exist on an in-memory SessionState. Fork of a persisted
// but inactive parent has no SessionState, so resume/load can register that
// parent and start writing its conversation DB while the fork is still
// snapshotting. A keyed lock serializes those setup paths regardless of
// whether the session is currently in the active map.

export class KeyedAsyncLock {
  readonly #tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.#tails.get(key) ?? Promise.resolve();
    const next: Promise<T> = prev.catch(() => undefined).then(() => fn());
    this.#tails.set(key, next);
    void next
      .finally(() => {
        if (this.#tails.get(key) === next) this.#tails.delete(key);
      })
      .catch(() => {});
    return next;
  }
}
