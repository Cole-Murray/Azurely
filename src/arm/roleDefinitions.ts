import { getAuthorizationClient } from "./client";
import { getAzureRoleDefinitions, type AzureRoleDefinition } from "../cache/azureRoleDefinitionsCache";

/**
 * Every Azure RBAC role assignment / PIM schedule instance returns
 * roleDefinitionId as a full resource path
 * (".../providers/Microsoft.Authorization/roleDefinitions/{guid}"), never a
 * bare GUID - unlike the directory plane, where roleDefinitionId already is
 * the bare GUID. This extracts the trailing GUID so it can be looked up
 * against the cached definitions list below.
 */
export function extractRoleDefinitionGuid(roleDefinitionId: string): string {
  const segments = roleDefinitionId.split("/");
  return segments[segments.length - 1];
}

/**
 * Lists every Azure RBAC role definition applicable at a subscription scope
 * and above (built-in roles like Owner/Contributor/Reader, plus any custom
 * roles), cached per subscription the same way listRoleDefinitions caches
 * directory roles per tenant - there's no server-side filter needed here
 * since the full set is small and mostly static.
 */
export async function listAzureRoleDefinitions(tenantId: string, subscriptionId: string): Promise<AzureRoleDefinition[]> {
  const cacheKey = `${tenantId}:${subscriptionId}`;
  return getAzureRoleDefinitions(cacheKey, async () => {
    const client = getAuthorizationClient(tenantId, subscriptionId);
    const definitions: AzureRoleDefinition[] = [];
    for await (const definition of client.roleDefinitions.list(`/subscriptions/${subscriptionId}`)) {
      if (definition.name && definition.roleName) {
        definitions.push({ id: definition.name, roleName: definition.roleName });
      }
    }
    return definitions;
  });
}

/**
 * Resolves a role definition id (full path or bare GUID - extractRoleDefinitionGuid
 * handles both) to its display name, falling back to the raw GUID if it's not
 * found in the cached list, or if listAzureRoleDefinitions itself throws (a
 * 403 at a scope narrower than what the caller's own assignment/PIM fetch
 * already proved accessible, a transient network error, throttling, etc).
 * Every caller of this function (get_azure_role_assignments,
 * get_azure_pim_assignments, get_azure_role_activation_history,
 * get_user_group_pim_eligibility) treats role-name resolution as enrichment
 * on top of data it already has - a role-definitions fetch failing must not
 * hard-fail the whole tool call, the same "show the GUID" degradation every
 * other unresolved-name case in this codebase (service principals, users)
 * already uses.
 */
export async function resolveAzureRoleName(tenantId: string, subscriptionId: string, roleDefinitionId: string): Promise<string> {
  const guid = extractRoleDefinitionGuid(roleDefinitionId);
  try {
    const definitions = await listAzureRoleDefinitions(tenantId, subscriptionId);
    return definitions.find((definition) => definition.id === guid)?.roleName ?? guid;
  } catch (err) {
    console.error(
      `[arm/roleDefinitions] could not resolve role name for ${guid} (leaving it as the raw GUID): ${err instanceof Error ? err.message : "unknown error"}`,
    );
    return guid;
  }
}
