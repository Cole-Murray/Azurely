import { AuthorizationManagementClient } from "@azure/arm-authorization";
import { SubscriptionClient } from "@azure/arm-subscriptions";
import { ResourceManagementClient } from "@azure/arm-resources";
import { getCredential } from "../auth/credential";

/**
 * The ARM (Azure Resource Manager, management.azure.com) sibling of
 * graph/client.ts. Unlike the Graph client, there's no custom middleware to
 * build here: the generated @azure/arm-* clients derive their credential
 * scope from their own default endpoint (`${endpoint}/.default`, i.e.
 * "https://management.azure.com/.default") automatically, and 429 handling
 * with Retry-After is already built into @azure/core-rest-pipeline's default
 * pipeline - there is nothing V1/V2's Graph client had to hand-roll
 * (throttling.ts) that ARM needs re-hand-rolled here.
 *
 * getCredential(tenantId) is reused completely unchanged from auth/credential.ts
 * - it returns an audience-neutral TokenCredential, and these SDK clients
 * request whatever scope they need from it themselves. See CLAUDE.md / the
 * V3 plan for why that's not a coincidence.
 */

const subscriptionClientCache = new Map<string, SubscriptionClient>();
const authorizationClientCache = new Map<string, AuthorizationManagementClient>();
const resourceClientCache = new Map<string, ResourceManagementClient>();

function scopedCacheKey(tenantId: string, subscriptionId: string): string {
  return `${tenantId}:${subscriptionId}`;
}

/** Tenant-level client - used for subscription discovery (no subscriptionId needed yet). */
export function getSubscriptionClient(tenantId: string): SubscriptionClient {
  const cached = subscriptionClientCache.get(tenantId);
  if (cached) {
    return cached;
  }
  const client = new SubscriptionClient(getCredential(tenantId));
  subscriptionClientCache.set(tenantId, client);
  return client;
}

/** Role assignments/definitions/PIM schedules all live under this client, scoped to one subscription. */
export function getAuthorizationClient(tenantId: string, subscriptionId: string): AuthorizationManagementClient {
  const key = scopedCacheKey(tenantId, subscriptionId);
  const cached = authorizationClientCache.get(key);
  if (cached) {
    return cached;
  }
  const client = new AuthorizationManagementClient(getCredential(tenantId), subscriptionId);
  authorizationClientCache.set(key, client);
  return client;
}

/** Resource-group enumeration, for scope discovery below the subscription level. */
export function getResourceClient(tenantId: string, subscriptionId: string): ResourceManagementClient {
  const key = scopedCacheKey(tenantId, subscriptionId);
  const cached = resourceClientCache.get(key);
  if (cached) {
    return cached;
  }
  const client = new ResourceManagementClient(getCredential(tenantId), subscriptionId);
  resourceClientCache.set(key, client);
  return client;
}

/** Test-only escape hatch - clears every ARM client cache between test cases. */
export function resetArmClientCacheForTests(): void {
  subscriptionClientCache.clear();
  authorizationClientCache.clear();
  resourceClientCache.clear();
}
