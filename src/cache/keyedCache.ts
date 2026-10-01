/**
 * A minimal get-or-fetch-on-miss cache keyed by an arbitrary string. Shared
 * by roleDefinitionsCache.ts (directory plane, keyed by tenantId) and
 * azureRoleDefinitionsCache.ts (ARM plane, keyed by `${tenantId}:${subscriptionId}`)
 * - both needed the exact same "fetch once per key, cache forever within the
 * process lifetime" contract, differing only in key composition and value
 * type, so that logic lives here once instead of twice.
 */
export interface KeyedCache<V> {
  /** Returns the cached value for `key`, calling `fetcher` only on a cache miss. */
  get(key: string, fetcher: () => Promise<V>): Promise<V>;
  /** Test-only escape hatch - clears every entry between test cases. */
  clearForTests(): void;
}

export function createKeyedCache<V>(): KeyedCache<V> {
  const cache = new Map<string, V>();

  return {
    async get(key: string, fetcher: () => Promise<V>): Promise<V> {
      const cached = cache.get(key);
      if (cached) {
        return cached;
      }
      const value = await fetcher();
      cache.set(key, value);
      return value;
    },
    clearForTests(): void {
      cache.clear();
    },
  };
}
