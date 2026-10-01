import { createKeyedCache } from "./keyedCache";

export interface RoleDefinition {
  id: string;
  displayName: string;
  description?: string;
  isBuiltIn: boolean;
}

// Keyed by tenantId - role definitions are tenant-specific, and this cache
// never expires within a process lifetime since built-in Entra roles almost
// never change. Restart the server to pick up the rare change.
const cache = createKeyedCache<RoleDefinition[]>();

/**
 * Returns cached role definitions for a tenant, calling `fetcher` only on a
 * cache miss. `fetcher` is injected rather than hardcoded to a Graph call so
 * this file has no dependency on the Graph SDK and can be unit tested
 * without mocking a single HTTP response.
 */
export async function getRoleDefinitions(tenantId: string, fetcher: () => Promise<RoleDefinition[]>): Promise<RoleDefinition[]> {
  return cache.get(tenantId, fetcher);
}

/** Test-only escape hatch - clears the cache between test cases. */
export function clearRoleDefinitionsCacheForTests(): void {
  cache.clearForTests();
}
