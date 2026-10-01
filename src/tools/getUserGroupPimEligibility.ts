import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveTenantSelector, tenantSelectorField } from "./shared/tenantSelector";
import { runTool } from "./shared/runTool";
import { getGraphClient } from "../graph/client";
import { fetchGroupEligibilityScheduleInstances, fetchGroupAssignmentScheduleInstances } from "../graph/pimGroupSchedules";
import { resolveUsers, type DirectoryUser } from "../graph/userDirectory";
import { getAuthorizationClient } from "../arm/client";
import { resolveAzureScopes, assertScopesDiscovered, assertNotAllScopesDenied, queryEachScope } from "../arm/scopeResolver";
import { resolveAzureRoleName } from "../arm/roleDefinitions";

/**
 * One PIM-for-Groups membership/ownership relationship for a user, optionally
 * enriched with the Azure RBAC role that group itself holds. This is the
 * only tool in the project that spans both the Graph plane (PIM for Groups)
 * and the ARM plane (the group's own role assignment) in a single call - see
 * the V3 plan for why: organizations commonly grant an Azure RBAC role
 * (Owner, Contributor, ...) to a *security group* rather than to
 * individuals, then put that group's *membership* under PIM governance
 * (e.g. a group literally named "SG-AZR-RG-Owner_RG-ClaudeAPI_PIM"). A user
 * becomes PIM-eligible for group *membership* (a Graph-plane fact);
 * activating it grants whatever Azure role the group already holds (an
 * ARM-plane fact) - answering "what am I really eligible for" needs both.
 */
export interface UserGroupPimEntry {
  groupId: string;
  /** Absent if Group.Read.All hasn't resolved it yet (not consented) or the group was deleted - see pimGroupSchedules.ts. */
  groupDisplayName?: string;
  /** Graph's own lowercase value: "member" | "owner". */
  accessId: string;
  assignmentType: "pim-eligible" | "pim-active" | "permanent";
  startDateTime?: string;
  endDateTime?: string;
  account: string;
  /**
   * The Azure RBAC role this group holds (if any), resolved via a best-effort
   * ARM cross-reference - see enrichAzureRoles below. Absent if the group
   * holds no standing Azure role, or if the cross-reference itself couldn't
   * run (see azureRoleLookupUnavailable on the result).
   */
  azureRole?: string;
  azureScope?: string;
}

export interface UserGroupPimEligibilityResult {
  accountsMatched: { id: string; displayName: string; userPrincipalName: string }[];
  groups: UserGroupPimEntry[];
  /** True only when the ARM cross-reference below couldn't run at all (e.g. Reader not yet granted anywhere) - the Graph-sourced eligibility data above is still complete and returned regardless. */
  azureRoleLookupUnavailable?: boolean;
}

async function fetchGroupPimForAccount(tenantId: string, user: DirectoryUser): Promise<UserGroupPimEntry[]> {
  const client = getGraphClient(tenantId);
  const principalFilter = `principalId eq '${user.id}'`;

  const [eligible, active] = await Promise.all([
    fetchGroupEligibilityScheduleInstances(client, principalFilter),
    fetchGroupAssignmentScheduleInstances(client, principalFilter),
  ]);

  return [
    ...eligible.map(
      (instance): UserGroupPimEntry => ({
        groupId: instance.groupId,
        groupDisplayName: instance.group?.displayName,
        accessId: instance.accessId ?? "member",
        assignmentType: "pim-eligible",
        startDateTime: instance.startDateTime,
        endDateTime: instance.endDateTime,
        account: user.userPrincipalName,
      }),
    ),
    ...active.map(
      (instance): UserGroupPimEntry => ({
        groupId: instance.groupId,
        groupDisplayName: instance.group?.displayName,
        accessId: instance.accessId ?? "member",
        // "activated" is a genuine time-boxed PIM activation; "assigned" is a
        // standing/permanent membership that happens to surface through this
        // same endpoint - the PIM-for-Groups analog of the exact
        // "Activated"/"Assigned" distinction the directory-role PIM code
        // already makes, just Graph's lowercase spelling for this API.
        assignmentType: instance.assignmentType === "activated" ? "pim-active" : "permanent",
        startDateTime: instance.startDateTime,
        endDateTime: instance.endDateTime,
        account: user.userPrincipalName,
      }),
    ),
  ];
}

/**
 * Best-effort: for every distinct group found above, checks whether that
 * group itself holds a standing Azure RBAC role assignment. Mutates
 * `entries` in place, filling in azureRole/azureScope on the FIRST matching
 * assignment found per group (a group holding the same kind of grant at more
 * than one scope is a known simplification, not modeled further - the common
 * real-world pattern this tool targets is one group, one dominant role).
 *
 * Issues exactly ONE roleAssignments.listForScope call per discovered scope,
 * regardless of how many distinct groups are being checked, then buckets the
 * unfiltered results locally against the groupIds set. This intentionally
 * trades "narrower per-call server-side filtering" for "fewer ARM round-trips"
 * - a user eligible for N groups across M subscriptions previously issued
 * N*M calls (one per group per scope); this issues M calls total. ARM has no
 * "principalId in (...)" filter, so narrowing further server-side isn't an
 * option - the alternative to this trade would be N*M narrow calls, not M
 * narrow calls.
 *
 * Any failure here (no subscriptions visible, every scope denied, or
 * anything else) degrades to azureRoleLookupUnavailable: true rather than
 * failing the whole tool call - this cross-reference is enrichment on top of
 * the Graph-sourced eligibility answer, not the core answer itself.
 */
async function enrichAzureRoles(tenantId: string, entries: UserGroupPimEntry[]): Promise<{ unavailable: boolean }> {
  const groupIds = new Set(entries.map((entry) => entry.groupId));
  if (groupIds.size === 0) {
    return { unavailable: false };
  }

  try {
    const scopes = await resolveAzureScopes(tenantId, undefined);
    assertScopesDiscovered(scopes);

    const { perScope, deniedScopes } = await queryEachScope(scopes, async (scope) => {
      const client = getAuthorizationClient(tenantId, scope.subscriptionId);
      const raw = [];
      for await (const assignment of client.roleAssignments.listForScope(scope.path)) {
        if (assignment.principalId && groupIds.has(assignment.principalId)) {
          raw.push(assignment);
        }
      }
      return raw;
    });
    assertNotAllScopesDenied(scopes, deniedScopes);

    for (const { scope, items } of perScope) {
      for (const assignment of items) {
        if (!assignment.roleDefinitionId || !assignment.principalId) {
          continue;
        }
        const roleName = await resolveAzureRoleName(tenantId, scope.subscriptionId, assignment.roleDefinitionId);
        for (const entry of entries) {
          if (entry.groupId === assignment.principalId && !entry.azureRole) {
            entry.azureRole = roleName;
            entry.azureScope = assignment.scope ?? scope.path;
          }
        }
      }
    }
    return { unavailable: false };
  } catch (err) {
    console.error(
      `[get_user_group_pim_eligibility] Azure RBAC cross-reference unavailable, leaving azureRole/azureScope unresolved: ${err instanceof Error ? err.message : "unknown error"}`,
    );
    return { unavailable: true };
  }
}

export async function getUserGroupPimEligibilityCore(tenantId: string, users: DirectoryUser[]): Promise<UserGroupPimEligibilityResult> {
  const perAccount = await Promise.all(users.map((user) => fetchGroupPimForAccount(tenantId, user)));
  const groups = perAccount.flat();

  const { unavailable } = await enrichAzureRoles(tenantId, groups);

  return {
    accountsMatched: users.map((user) => ({ id: user.id, displayName: user.displayName, userPrincipalName: user.userPrincipalName })),
    groups,
    ...(unavailable ? { azureRoleLookupUnavailable: true as const } : {}),
  };
}

const inputShape = {
  userId: z.string().trim().min(2),
  tenant: tenantSelectorField,
};

/**
 * Registers get_user_group_pim_eligibility: which PIM-governed security
 * groups a user is eligible to activate membership/ownership in, and (best
 * effort) what Azure RBAC role each group actually grants. Accepts a user
 * id, userPrincipalName, or free-text search (aggregates across every
 * matched account, same as get_user_directory_roles).
 */
export function registerGetUserGroupPimEligibility(server: McpServer): void {
  server.registerTool(
    "get_user_group_pim_eligibility",
    {
      description:
        "List the PIM-governed security groups a user is eligible to activate membership/ownership in, and which ones they currently hold (standing or time-boxed-active), cross-referenced where possible with the Azure RBAC role each group itself grants (e.g. Owner on a resource group) - the common pattern where a group carries the Azure role and PIM governs who can join it. Accepts a user id, userPrincipalName, or free-text name search; a search matching multiple accounts for the same person returns results for all of them. If azureRoleLookupUnavailable is true in the result, the Azure-role cross-reference could not run (e.g. Reader not yet granted) - the group eligibility data is still complete, but azureRole/azureScope will be absent even where a group does hold a role.",
      inputSchema: inputShape,
    },
    async (args) => {
      return runTool("get_user_group_pim_eligibility", args, async () => {
        const tenantId = resolveTenantSelector(args.tenant).tenantId;
        const users = await resolveUsers(tenantId, args.userId);
        return getUserGroupPimEligibilityCore(tenantId, users);
      });
    },
  );
}
