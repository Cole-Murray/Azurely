import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resolveTenantSelector, tenantSelectorField } from "./shared/tenantSelector";
import { runTool } from "./shared/runTool";
import { getAuthorizationClient } from "../arm/client";
import { azureScopeField, resolveAzureScopes, assertScopesDiscovered, assertNotAllScopesDenied, queryEachScope, firstSeenById, type AzureScope } from "../arm/scopeResolver";
import { extractRoleDefinitionGuid, resolveAzureRoleName } from "../arm/roleDefinitions";
import { enrichArmPrincipalNames } from "../arm/principalEnrichment";

/**
 * One principal's relationship to a role at an Azure scope, whether a
 * standing (permanent) assignment or a PIM-governed eligible/active one.
 * Mirrors the directory plane's UserRoleEntry discriminated union
 * (getUserDirectoryRoles.ts) so both planes read the same way.
 */
export interface AzurePimAssignmentEntry {
  principalId: string;
  /** ARM's own principal-type spelling - see the comment on AzureRoleAssignmentHolder in getAzureRoleAssignments.ts for why this isn't normalized to the Graph-derived lowercase convention. */
  principalType: string;
  principalDisplayName?: string;
  roleDefinitionId: string;
  roleName: string;
  scope: string;
  assignmentType: "permanent" | "pim-active" | "pim-eligible";
  startDateTime?: string;
  endDateTime?: string;
}

export interface AzurePimAssignmentsResult {
  scopesQueried: string[];
  assignments: AzurePimAssignmentEntry[];
  /** Present (true) only when at least one queried scope was denied (403) - see queryEachScope's degrade-gracefully contract in scopeResolver.ts. */
  accessDeniedForSomeScopes?: boolean;
}

export async function getAzurePimAssignmentsCore(tenantId: string, explicitScope: string | undefined): Promise<AzurePimAssignmentsResult> {
  const scopes = await resolveAzureScopes(tenantId, explicitScope);
  assertScopesDiscovered(scopes);

  const [activeResult, eligibleResult] = await Promise.all([
    queryEachScope(scopes, async (scope: AzureScope) => {
      const client = getAuthorizationClient(tenantId, scope.subscriptionId);
      const raw = [];
      for await (const instance of client.roleAssignmentScheduleInstances.listForScope(scope.path)) {
        raw.push(instance);
      }
      return raw;
    }),
    queryEachScope(scopes, async (scope: AzureScope) => {
      const client = getAuthorizationClient(tenantId, scope.subscriptionId);
      const raw = [];
      for await (const instance of client.roleEligibilityScheduleInstances.listForScope(scope.path)) {
        raw.push(instance);
      }
      return raw;
    }),
  ]);

  // Both legs query the same scopes with the same permission, so a scope
  // denied on one is denied on both - the union is reported once rather than
  // risking the two lists disagreeing about which scopes were unusable.
  const deniedScopes = [...new Set([...activeResult.deniedScopes, ...eligibleResult.deniedScopes])];
  assertNotAllScopesDenied(scopes, deniedScopes);

  const entries: AzurePimAssignmentEntry[] = [];

  // A schedule instance made at a parent scope (management group, root "/")
  // is returned by every descendant subscription's listForScope call, not
  // just once - see firstSeenById's docstring. Active and eligible instances
  // never share an id (different endpoints, different ARM resource types),
  // but each still needs its own guard against repeating across scopes.
  const seenActiveIds = new Set<string>();
  const seenEligibleIds = new Set<string>();

  for (const { scope, items } of activeResult.perScope) {
    for (const instance of items) {
      if (!instance.principalId || !instance.roleDefinitionId) {
        continue;
      }
      if (!firstSeenById(seenActiveIds, instance.id)) {
        continue;
      }
      const roleName = await resolveAzureRoleName(tenantId, scope.subscriptionId, instance.roleDefinitionId);
      entries.push({
        principalId: instance.principalId,
        principalType: instance.principalType ?? "Unknown",
        roleDefinitionId: extractRoleDefinitionGuid(instance.roleDefinitionId),
        roleName,
        scope: instance.scope ?? scope.path,
        // roleAssignmentScheduleInstances mixes genuine time-boxed PIM
        // activations ("Activated") with standing/permanent grants that
        // happen to surface through this same endpoint ("Assigned") -
        // exactly the same distinction the directory plane's
        // fetchRolesForAccount already makes (getUserDirectoryRoles.ts).
        assignmentType: instance.assignmentType === "Activated" ? "pim-active" : "permanent",
        startDateTime: instance.startDateTime?.toISOString(),
        endDateTime: instance.endDateTime?.toISOString(),
      });
    }
  }

  for (const { scope, items } of eligibleResult.perScope) {
    for (const instance of items) {
      if (!instance.principalId || !instance.roleDefinitionId) {
        continue;
      }
      if (!firstSeenById(seenEligibleIds, instance.id)) {
        continue;
      }
      const roleName = await resolveAzureRoleName(tenantId, scope.subscriptionId, instance.roleDefinitionId);
      entries.push({
        principalId: instance.principalId,
        principalType: instance.principalType ?? "Unknown",
        roleDefinitionId: extractRoleDefinitionGuid(instance.roleDefinitionId),
        roleName,
        scope: instance.scope ?? scope.path,
        assignmentType: "pim-eligible",
        startDateTime: instance.startDateTime?.toISOString(),
        endDateTime: instance.endDateTime?.toISOString(),
      });
    }
  }

  await enrichArmPrincipalNames(tenantId, [entries]);

  return {
    scopesQueried: scopes.map((scope) => scope.path),
    assignments: entries,
    ...(deniedScopes.length > 0 ? { accessDeniedForSomeScopes: true as const } : {}),
  };
}

const inputShape = {
  scope: azureScopeField,
  tenant: tenantSelectorField,
};

/**
 * Registers get_azure_pim_assignments: who is PIM-eligible to activate a
 * role at an Azure scope, and who currently holds an active (standing or
 * time-boxed) one - the Azure-resource-PIM counterpart to
 * get_user_directory_roles' PIM view on the directory plane. Scans every
 * subscription the app's service principal can see by default; pass scope
 * to narrow it.
 */
export function registerGetAzurePimAssignments(server: McpServer): void {
  server.registerTool(
    "get_azure_pim_assignments",
    {
      description:
        "List Azure resource PIM state at a subscription or resource group: who is eligible to activate a role, and who currently holds an active assignment (whether a genuine time-boxed PIM activation or a standing/permanent grant). Scans every subscription the app's service principal can see in this tenant by default; pass scope to narrow it to one subscription or resource group. If accessDeniedForSomeScopes is true in the result, at least one scanned subscription denied access (Reader not yet granted there) and the assignment list may be incomplete.",
      inputSchema: inputShape,
    },
    async (args) => {
      return runTool("get_azure_pim_assignments", args, async () => {
        const tenantId = resolveTenantSelector(args.tenant).tenantId;
        return getAzurePimAssignmentsCore(tenantId, args.scope);
      });
    },
  );
}
