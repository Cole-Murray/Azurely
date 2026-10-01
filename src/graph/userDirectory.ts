import { getGraphClient } from "./client";
import { withEventualConsistency } from "./advancedQuery";
import { AmbiguousMatchError, NotFoundError } from "../tools/shared/errors";

export interface DirectoryUser {
  id: string;
  displayName: string;
  userPrincipalName: string;
  mail: string | null;
  accountEnabled: boolean;
}

const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SELECT_FIELDS = ["id", "displayName", "userPrincipalName", "mail", "accountEnabled"];

// $search's query syntax delimits each clause with double quotes; a literal
// quote inside the value would terminate a clause early and malform the
// whole expression, so strip it rather than try to escape it - a legitimate
// name/UPN/mail search has no reason to contain one.
function escapeSearchLiteral(value: string): string {
  return value.replace(/"/g, "");
}

/**
 * The core Graph query behind search_users. The user directory is too large
 * to fetch in full (unlike role definitions), so this always issues a
 * server-side query rather than fetching-and-filtering in memory.
 *
 * Uses $search rather than $filter startswith(): Graph's /users $filter only
 * supports startswith() (contains() is rejected outright with
 * Request_UnsupportedQuery), so a person whose display name, UPN, or mail
 * doesn't *start with* the query text is invisible to it - e.g. a privileged
 * "(Admin) Jordan Lee" account is missed by a search for "jordan lee"
 * even though it's clearly the same person. $search does token-based
 * matching instead of prefix matching and finds it. Confirmed live against
 * Graph Explorer before writing this. $search still needs
 * ConsistencyLevel: eventual + count(true), same as the $filter version did.
 */
export async function searchUsersCore(tenantId: string, query: string, limit: number): Promise<DirectoryUser[]> {
  const client = getGraphClient(tenantId);
  const escaped = escapeSearchLiteral(query);
  const search = `"displayName:${escaped}" OR "userPrincipalName:${escaped}" OR "mail:${escaped}"`;

  const request = client.api("/users").search(search).select(SELECT_FIELDS).top(limit).count(true);
  const response = await withEventualConsistency(request).get();
  return response.value as DirectoryUser[];
}

// A free-text name search can legitimately hit multiple accounts that
// belong to the same person - e.g. a standing account and a separate
// privileged "(Admin) Name" account, which $search's token matching (see
// searchUsersCore) now surfaces where startswith() used to miss it. Rather
// than forcing a caller to guess which one to check first,
// get_user_directory_roles wants every one of them. This cap bounds that
// aggregation to a small, plausibly-one-person set of accounts - a query
// broad enough to match more than this many distinct people (e.g. a bare
// first name) is a query that needs narrowing, not a person to aggregate.
const MAX_AGGREGATED_MATCHES = 5;

/**
 * Resolves every user matching a GUID/UPN (direct GET /users/{id}, always
 * exactly one) or a free-text query (searchUsersCore, one or more, up to
 * MAX_AGGREGATED_MATCHES). Shared by get_user_directory_roles and
 * assess_role_risk so the "which of these counts as a direct lookup" rule
 * lives in one place.
 */
export async function resolveUsers(tenantId: string, userIdOrQuery: string): Promise<DirectoryUser[]> {
  const isDirectLookup = GUID_PATTERN.test(userIdOrQuery) || userIdOrQuery.includes("@");
  const client = getGraphClient(tenantId);

  if (isDirectLookup) {
    try {
      return [(await client.api(`/users/${encodeURIComponent(userIdOrQuery)}`).select(SELECT_FIELDS).get()) as DirectoryUser];
    } catch (err) {
      if (err instanceof Error && "statusCode" in err && (err as { statusCode: number }).statusCode === 404) {
        throw new NotFoundError(`No user found for "${userIdOrQuery}".`);
      }
      throw err;
    }
  }

  // Fetch one past the cap so a result at/over it is distinguishable from
  // "exactly the cap, and that's everyone."
  const matches = await searchUsersCore(tenantId, userIdOrQuery, MAX_AGGREGATED_MATCHES + 1);
  if (matches.length === 0) {
    throw new NotFoundError(`No user found matching "${userIdOrQuery}".`);
  }
  if (matches.length > MAX_AGGREGATED_MATCHES) {
    throw new AmbiguousMatchError(
      `"${userIdOrQuery}" matched more than ${MAX_AGGREGATED_MATCHES} users - use a full userPrincipalName or object id to narrow it down.`,
    );
  }
  return matches;
}

// Keyed by `${tenantId}:${userId}` -> displayName. Mirrors
// servicePrincipalDirectory.ts's cache contract exactly: display names are
// rename-stable enough to cache for the process lifetime, and a negative
// result (an id that couldn't be resolved) is intentionally NOT cached since
// that's usually transient rather than permanent.
const userNameCache = new Map<string, string>();

function userNameCacheKey(tenantId: string, id: string): string {
  return `${tenantId}:${id}`;
}

/**
 * Resolves bare user object ids to display names. Needed specifically by the
 * Azure RBAC tools (get_azure_role_assignments, get_azure_pim_assignments,
 * get_azure_role_activation_history): unlike the directory plane's
 * $expand=principal, ARM's roleAssignments/PIM schedule objects return only
 * a principalId GUID for every principal type - there is no ARM-side
 * expand/select that populates a display name. Deliberately separate from
 * resolveUsers (a "resolve exactly one user, throw if not found" lookup
 * built for user-facing tool input) - this is a "resolve many ids, tolerate
 * misses" helper, the same shape as resolveServicePrincipalNames.
 *
 * @returns a Map of id -> displayName containing only the ids that resolved.
 */
export async function resolveUserDisplayNames(tenantId: string, ids: string[]): Promise<Map<string, string>> {
  const resolved = new Map<string, string>();
  const uniqueIds = [...new Set(ids)];

  const toFetch: string[] = [];
  for (const id of uniqueIds) {
    const cached = userNameCache.get(userNameCacheKey(tenantId, id));
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
        const user = (await client.api(`/users/${encodeURIComponent(id)}`).select(["id", "displayName"]).get()) as { displayName?: string };
        if (user?.displayName) {
          userNameCache.set(userNameCacheKey(tenantId, id), user.displayName);
          resolved.set(id, user.displayName);
        }
      } catch {
        // Intentionally swallowed - same "degrades gracefully" reasoning as
        // resolveServicePrincipalNames: a failure just leaves this holder
        // showing its GUID rather than failing the whole call.
        console.error("[userDirectory] could not resolve a user display name (leaving it unresolved)");
      }
    }),
  );

  return resolved;
}

/** Test-only escape hatch - clears the user display-name cache between test cases. */
export function clearUserNameCacheForTests(): void {
  userNameCache.clear();
}
