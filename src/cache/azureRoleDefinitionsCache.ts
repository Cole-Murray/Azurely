import { createKeyedCache } from "./keyedCache";

/** A trimmed Azure RBAC role definition - just enough to resolve a GUID to a human-readable name. */
export interface AzureRoleDefinition {
  /** The bare role definition GUID (ARM's `name` property on the resource, not `id` - see arm/roleDefinitions.ts). */
  id: string;
  roleName: string;
}

// Keyed by `${tenantId}:${subscriptionId}` - Azure role definitions (built-in
// + any custom roles) are effectively static within a subscription's
// lifetime, so (like roleDefinitionsCache.ts on the directory plane) this
// never expires within a process lifetime; restart the server to pick up a
// rare change (e.g. a newly added custom role).
const cache = createKeyedCache<AzureRoleDefinition[]>();

/**
 * Returns cached Azure role definitions for a subscription, calling `fetcher`
 * only on a cache miss. `fetcher` is injected rather than hardcoded to an ARM
 * call so this file has no dependency on the @azure/arm-* SDK and can be unit
 * tested without mocking a single HTTP response - same rationale as
 * roleDefinitionsCache.ts on the directory plane.
 */
export async function getAzureRoleDefinitions(cacheKey: string, fetcher: () => Promise<AzureRoleDefinition[]>): Promise<AzureRoleDefinition[]> {
  return cache.get(cacheKey, fetcher);
}

/** Test-only escape hatch - clears the cache between test cases. */
export function clearAzureRoleDefinitionsCacheForTests(): void {
  cache.clearForTests();
}
