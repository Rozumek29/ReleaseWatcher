/**
 * Memoizes `compute` until `revision()` returns another value. Used with `RepositoryStore.revision()` for values
 * derived only from the database: they are computed again only after something was written.
 */
export function cachedByRevision<T>(revision: () => number, compute: () => T): () => T {
  let cached: { revision: number; value: T } | null = null;
  return () => {
    const current = revision();
    if (cached === null || cached.revision !== current) {
      cached = { revision: current, value: compute() };
    }
    return cached.value;
  };
}
