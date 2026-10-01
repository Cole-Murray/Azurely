import { getGraphClient } from "./client";

/** Fields we read off a service principal - kept minimal per Graph's own $select performance guidance. */
interface ServicePrincipalSummary {
  id?: string;
  displayName?: string;
  appId?: string;
}

// Keyed by `${tenantId}:${servicePrincipalId}` -> displayName. Service
// principal display names change about as rarely as role definitions, so
// (like roleDefinitionsCache) this never expires within a process lifetime;
// restart the server to pick up a rename. A negative result (an id that
// couldn't be resolved) is intentionally NOT cached: those are usually
// transient (throttling, a not-yet-consented permission) and worth retrying
// on the next call rather than being remembered as "no name forever."
const nameCache = new Map<string, string>();

function cacheKey(tenantId: string, id: string): string {
  return `${tenantId}:${id}`;
}

/**
 * Resolves service principal (application) object ids to display names.
 *
 * Why this exists: get_role_assignments expands the `principal` on each role
 * assignment, but under our permission set Graph only populates displayName
 * for *user* principals. Service-principal holders come back as a bare GUID,
 * which is useless in a "who holds Global Admin" answer. Application.Read.All
 * lets us read the service principal object directly to get its name.
 *
 * One GET per uncached id (rather than a single $filter with an `or` chain):
 * ids are resolved individually so each result is independently cacheable and
 * a single deleted/unreadable SP can't poison a whole batch. The set of SP
 * holders on a given role is small, so the call count stays low - and repeats
 * are served from cache.
 *
 * Degrades gracefully: if an individual id can't be read (deleted SP, 404, or
 * a permission not yet consented), that id is simply omitted from the result
 * map instead of failing the whole role listing - the caller already treats a
 * missing name as "show the GUID," matching the existing behavior for groups.
 *
 * @returns a Map of id -> displayName containing only the ids that resolved.
 */
export async function resolveServicePrincipalNames(tenantId: string, ids: string[]): Promise<Map<string, string>> {
  const resolved = new Map<string, string>();
  const uniqueIds = [...new Set(ids)];

  const toFetch: string[] = [];
  for (const id of uniqueIds) {
    const cached = nameCache.get(cacheKey(tenantId, id));
    if (cached !== undefined) {
      resolved.set(id, cached);
    } else {
      toFetch.push(id);
    }
  }

  if (toFetch.length === 0) {
    return resolved;
  }

  const client = getGraphClient(tenantId);

  await Promise.all(
    toFetch.map(async (id) => {
      try {
        const sp = (await client
          .api(`/servicePrincipals/${encodeURIComponent(id)}`)
          .select(["id", "displayName", "appId"])
          .get()) as ServicePrincipalSummary;

        if (sp?.displayName) {
          nameCache.set(cacheKey(tenantId, id), sp.displayName);
          resolved.set(id, sp.displayName);
        }
      } catch {
        // Intentionally swallowed - see the "degrades gracefully" note above.
        // No secrets or ids are logged here; a failure just leaves the holder
        // showing its GUID, which is the pre-existing fallback behavior.
        console.error("[servicePrincipalDirectory] could not resolve a service principal display name (leaving it unresolved)");
      }
    }),
  );

  return resolved;
}

/** Test-only escape hatch - clears the cache between test cases. */
export function clearServicePrincipalCacheForTests(): void {
  nameCache.clear();
}
