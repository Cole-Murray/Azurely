import { z } from "zod";
import { getSubscriptionClient } from "./client";
import { isArmScopeAccessDenied } from "./armErrors";
import { ToolInputError } from "../tools/shared/errors";

export interface AzureScope {
  /** Full ARM scope path, e.g. "/subscriptions/{id}" or "/subscriptions/{id}/resourceGroups/{name}". */
  path: string;
  subscriptionId: string;
}

// Resource group names allow alphanumerics, underscore, parentheses, hyphen,
// and period (per Azure's own naming rules) - [^/]+ is deliberately
// permissive here rather than re-encoding that whole character class, since
// this pattern's real job is just rejecting the "not shaped like an ARM
// scope at all" case before any Azure call is attempted.
const SCOPE_PATTERN = /^\/subscriptions\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\/resourceGroups\/[^/]+)?$/i;

/**
 * The zod field shared by every ARM tool's inputShape (get_azure_role_assignments,
 * get_azure_pim_assignments, get_azure_role_activation_history) - the ARM
 * plane's analog of tenantSelectorField. Validated with a regex (like roleId's
 * z.string().uuid()) so a malformed scope is rejected by the SDK before this
 * tool's callback - and therefore before any Azure call - ever runs.
 */
export const azureScopeField = z
  .string()
  .trim()
  .regex(SCOPE_PATTERN, 'Expected "/subscriptions/{subscriptionId}" or "/subscriptions/{subscriptionId}/resourceGroups/{resourceGroupName}".')
  .optional()
  .describe(
    'Optional. Narrows the query to one Azure scope - a subscription ("/subscriptions/{id}") or resource group ("/subscriptions/{id}/resourceGroups/{name}"). Omit to scan every subscription the app\'s service principal can see in this tenant.',
  );

/** Parses and extracts the subscriptionId from a caller-supplied scope. Assumes the zod regex above already validated the shape; throws ToolInputError as a defensive fallback for any caller that reaches this without going through that schema (e.g. a direct unit test of *Core). */
export function parseExplicitScope(scope: string): AzureScope {
  const trimmed = scope.trim();
  const match = SCOPE_PATTERN.exec(trimmed);
  if (!match) {
    throw new ToolInputError(
      `"${scope}" is not a recognized Azure scope. Expected "/subscriptions/{subscriptionId}" or "/subscriptions/{subscriptionId}/resourceGroups/{resourceGroupName}".`,
    );
  }
  const subscriptionId = trimmed.split("/")[2];
  return { path: trimmed, subscriptionId };
}

/**
 * Enumerates every subscription visible to the app's service principal in
 * this tenant - the "auto-discover" default every ARM tool falls back to
 * when no explicit scope is given. Logged to stderr so a silently-narrow
 * result (e.g. only 1 of 12 subscriptions granted) is visible rather than
 * misread as "this tenant only has one subscription" - see CLAUDE.md's "no
 * silent caps" expectation.
 */
export async function discoverSubscriptionScopes(tenantId: string): Promise<AzureScope[]> {
  const client = getSubscriptionClient(tenantId);
  const scopes: AzureScope[] = [];
  for await (const subscription of client.subscriptions.list()) {
    if (subscription.subscriptionId) {
      scopes.push({ path: `/subscriptions/${subscription.subscriptionId}`, subscriptionId: subscription.subscriptionId });
    }
  }
  console.error(`[arm/scopeResolver] discovered ${scopes.length} subscription(s) visible to tenant ${tenantId}`);
  return scopes;
}

/** The single entry point every ARM tool's input handling calls: an explicit scope narrows to exactly one; omitted means "every subscription this tenant's app registration can see." */
export async function resolveAzureScopes(tenantId: string, explicitScope?: string): Promise<AzureScope[]> {
  if (explicitScope) {
    return [parseExplicitScope(explicitScope)];
  }
  return discoverSubscriptionScopes(tenantId);
}

/** Throws when scope discovery/parsing produced nothing to query at all - distinct from "queried some scopes and all were denied" below, which needs the query attempt to have happened first. */
export function assertScopesDiscovered(scopes: AzureScope[]): void {
  if (scopes.length === 0) {
    throw new Error(
      "No Azure subscriptions are visible to this tenant's app registration. Grant the app's service principal the Reader role at the tenant's root management group, then retry.",
    );
  }
}

export interface ScopedQueryResult<T> {
  perScope: { scope: AzureScope; items: T[] }[];
  /** Scope paths that 403'd - Reader not yet granted there. */
  deniedScopes: string[];
}

/**
 * Runs `fetch` against every resolved scope in parallel, tolerating a denied
 * scope (see isArmScopeAccessDenied - a plain 403, or the 400/
 * InsufficientPermissions shape Azure's PIM schedule-instance endpoints use
 * instead) by recording it in deniedScopes and continuing with the rest,
 * rather than failing the whole call. This is what lets a partial Reader
 * rollout (granted at some subscriptions but not others, before the
 * root-management-group grant lands everywhere) degrade instead of erroring
 * outright - the same "degrade gracefully on access-denied, rethrow anything
 * else" discipline the directory-plane PIM code already follows for P2
 * licensing gaps. Callers must still call assertNotAllScopesDenied afterward:
 * this function alone can't tell "some scopes had zero results" apart from
 * "some scopes were denied," and a caller getting an all-denied response back
 * disguised as "0 assignments found" would be actively misleading.
 */
export async function queryEachScope<T>(scopes: AzureScope[], fetch: (scope: AzureScope) => Promise<T[]>): Promise<ScopedQueryResult<T>> {
  const deniedScopes: string[] = [];
  const perScope = await Promise.all(
    scopes.map(async (scope) => {
      try {
        return { scope, items: await fetch(scope) };
      } catch (err) {
        if (isArmScopeAccessDenied(err)) {
          deniedScopes.push(scope.path);
          return { scope, items: [] as T[] };
        }
        throw err;
      }
    }),
  );
  return { perScope, deniedScopes };
}

export function assertNotAllScopesDenied(scopes: AzureScope[], deniedScopes: string[]): void {
  if (scopes.length > 0 && deniedScopes.length === scopes.length) {
    throw new Error(
      "Azure Resource Manager denied every queried scope - the app's service principal likely hasn't been granted the Reader role (or higher) at this tenant's root management group yet.",
    );
  }
}

/**
 * Marks `id` as seen and returns true the first time it's passed a given
 * `seen` set; returns false on every repeat. An item with no `id` is always
 * treated as new (returns true) rather than silently dropped.
 *
 * Exists because listForScope-style ARM endpoints return assignments/PIM
 * schedule instances/requests inherited from parent scopes (a management
 * group, or root "/") on *every* descendant subscription's query, not just
 * once - confirmed live against a real tenant, where a single root-scope
 * role assignment came back 18 times, once per discovered subscription, with
 * nothing downstream collapsing the repeats back down. Every get_azure_*
 * tool that fans a single query out across every discovered subscription
 * (getAzureRoleAssignments.ts, getAzurePimAssignments.ts,
 * getAzureRoleActivationHistory.ts) needs this same guard, so it lives here
 * once rather than three times. Azure's own id for the underlying record is
 * stable across those repeated appearances (it's the same object, just
 * visible from multiple scopes), so it's the correct de-dup key - unlike
 * (principalId, roleDefinitionId, scope), which two genuinely distinct
 * bindings could in principle share.
 */
export function firstSeenById(seen: Set<string>, id: string | undefined): boolean {
  if (!id) {
    return true;
  }
  if (seen.has(id)) {
    return false;
  }
  seen.add(id);
  return true;
}
