import { getGraphClient } from "./client";
import { getRoleDefinitions, type RoleDefinition } from "../cache/roleDefinitionsCache";

/**
 * The single place that actually calls Graph for role definitions. Role
 * definitions are a small, mostly-static set (~100 built-in roles plus any
 * custom ones), so every caller fetches the full list once per tenant
 * process lifetime (via the shared cache) and filters in memory - there's
 * no server-side $filter needed here, unlike search_users where the
 * directory is too large to fetch in full.
 */
export async function listRoleDefinitions(tenantId: string): Promise<RoleDefinition[]> {
  return getRoleDefinitions(tenantId, async () => {
    const client = getGraphClient(tenantId);
    const response = await client.api("/roleManagement/directory/roleDefinitions").select(["id", "displayName", "description", "isBuiltIn"]).get();
    return response.value as RoleDefinition[];
  });
}
