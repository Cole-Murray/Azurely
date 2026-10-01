import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveTenantSelector, tenantSelectorField } from "./shared/tenantSelector";
import { runTool } from "./shared/runTool";
import { getAuthorizationClient } from "../arm/client";
import { azureScopeField, resolveAzureScopes, assertScopesDiscovered, assertNotAllScopesDenied, queryEachScope, firstSeenById, type AzureScope } from "../arm/scopeResolver";
import { extractRoleDefinitionGuid, resolveAzureRoleName } from "../arm/roleDefinitions";
import { enrichArmPrincipalNames } from "../arm/principalEnrichment";

/**
 * One principal (user, group, or service principal) holding a standing
 * (non-PIM) Azure RBAC role assignment at a given scope.
 */
export interface AzureRoleAssignmentHolder {
  principalId: string;
  /**
   * ARM's own principal-type spelling (e.g. "User", "Group",
   * "ServicePrincipal") - a different vocabulary than the Graph-derived,
   * lowercase @odata.type strings used on the directory plane
   * (RoleAssignmentHolder.principalType in getRoleAssignments.ts). Left
   * as-is rather than normalized to match: these are two genuinely
   * different data sources, and forcing one into the other's casing would
   * be a false-consistency claim, not an actual simplification.
   */
  principalType: string;
  /** Absent for group holders by design (Group.Read.All not granted for this tool - see CLAUDE.md) or if resolution otherwise failed. */
  principalDisplayName?: string;
  /** Bare role definition GUID (see arm/roleDefinitions.ts - ARM returns this as a full resource path everywhere else). */
  roleDefinitionId: string;
  roleName: string;
  /** The exact ARM scope this assignment applies to - may be at or above the scope that was queried. */
  scope: string;
}

export interface AzureRoleAssignmentsResult {
  scopesQueried: string[];
  assignments: AzureRoleAssignmentHolder[];
  /** Present (true) only when at least one queried scope was denied (403) - Reader not yet granted there. Assignments from every other, successfully-queried scope are still returned; see queryEachScope's degrade-gracefully contract. */
  accessDeniedForSomeScopes?: boolean;
}

/**
 * Core lookup logic, exported separately from tool registration - same
 * pattern as getRoleAssignmentsCore on the directory plane.
 */
export async function getAzureRoleAssignmentsCore(
  tenantId: string,
  explicitScope: string | undefined,
  roleNameFilter: string | undefined,
): Promise<AzureRoleAssignmentsResult> {
  const scopes = await resolveAzureScopes(tenantId, explicitScope);
  assertScopesDiscovered(scopes);

  const { perScope, deniedScopes } = await queryEachScope(scopes, async (scope: AzureScope) => {
    const client = getAuthorizationClient(tenantId, scope.subscriptionId);
    const raw = [];
    for await (const assignment of client.roleAssignments.listForScope(scope.path)) {
      raw.push(assignment);
    }
    return raw;
  });
  assertNotAllScopesDenied(scopes, deniedScopes);

  const holders: AzureRoleAssignmentHolder[] = [];
  const seenAssignmentIds = new Set<string>();
  for (const { scope, items } of perScope) {
    for (const assignment of items) {
      if (!assignment.principalId || !assignment.roleDefinitionId) {
        continue;
      }
      // An assignment made at a parent scope (management group, root "/") is
      // returned by every descendant subscription's listForScope call, not
      // just once - see firstSeenById's docstring.
      if (!firstSeenById(seenAssignmentIds, assignment.id)) {
        continue;
      }
      const roleName = await resolveAzureRoleName(tenantId, scope.subscriptionId, assignment.roleDefinitionId);
      holders.push({
        principalId: assignment.principalId,
        principalType: assignment.principalType ?? "Unknown",
        roleDefinitionId: extractRoleDefinitionGuid(assignment.roleDefinitionId),
        roleName,
        scope: assignment.scope ?? scope.path,
      });
    }
  }

  await enrichArmPrincipalNames(tenantId, [holders]);

  const filtered = roleNameFilter ? holders.filter((holder) => holder.roleName.toLowerCase() === roleNameFilter.toLowerCase()) : holders;

  return {
    scopesQueried: scopes.map((scope) => scope.path),
    assignments: filtered,
    ...(deniedScopes.length > 0 ? { accessDeniedForSomeScopes: true as const } : {}),
  };
}

const inputShape = {
  scope: azureScopeField,
  roleName: z.string().trim().min(2).optional(),
  tenant: tenantSelectorField,
};

/**
 * Registers get_azure_role_assignments: standing (non-PIM) Azure RBAC role
 * assignments - who holds Owner/Contributor/Reader/etc on a subscription or
 * resource group. Scans every subscription the app's service principal can
 * see in the tenant by default; pass scope to narrow to one subscription or
 * resource group.
 */
export function registerGetAzureRoleAssignments(server: McpServer): void {
  server.registerTool(
    "get_azure_role_assignments",
    {
      description:
        "List standing (non-PIM) Azure RBAC role assignments - who holds Owner, Contributor, Reader, etc. on an Azure subscription or resource group. Scans every subscription the app's service principal can see in this tenant by default; pass scope (a subscription or resource group ARM path) to narrow it. Optionally filter to a specific roleName. Group principal names are left unresolved by design (see CLAUDE.md); user and service principal names are resolved where possible. If accessDeniedForSomeScopes is true in the result, at least one scanned subscription denied access (Reader not yet granted there) and the assignment list may be incomplete.",
      inputSchema: inputShape,
    },
    async (args) => {
      return runTool("get_azure_role_assignments", args, async () => {
        const tenantId = resolveTenantSelector(args.tenant).tenantId;
        return getAzureRoleAssignmentsCore(tenantId, args.scope, args.roleName);
      });
    },
  );
}
