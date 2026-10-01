import { GraphError } from "@microsoft/microsoft-graph-client";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveTenantSelector, tenantSelectorField } from "./shared/tenantSelector";
import { getGraphClient } from "../graph/client";
import { fetchRoleAssignmentScheduleInstances, fetchRoleEligibilityScheduleInstances, type ScheduleInstance } from "../graph/pimSchedules";
import { resolveUsers, type DirectoryUser } from "../graph/userDirectory";
import { runTool } from "./shared/runTool";

export interface UserRoleEntry {
  roleDefinitionId: string;
  roleDisplayName: string;
  assignmentType: "permanent" | "pim-active" | "pim-eligible";
  startDateTime?: string;
  endDateTime?: string;
  // userPrincipalName of the account this role belongs to. A free-text
  // query can resolve to more than one account for the same person (see
  // resolveUsers) - this is what lets the caller tell those apart instead
  // of the roles reading as one undifferentiated pile.
  account: string;
}

export interface UserDirectoryRolesResult {
  accountsMatched: { id: string; displayName: string; userPrincipalName: string }[];
  roles: UserRoleEntry[];
  // Set true only when the PIM fallback below was taken for at least one
  // matched account - absent (not false) on the happy path so callers/tests
  // can tell "we checked and PIM is fine" apart from "we never checked."
  pimUnavailable?: boolean;
}

/** Resolves a display name for a role from a schedule instance's expanded roleDefinition, falling back to the raw id if the $expand didn't come back populated. */
function roleDisplayNameOf(instance: ScheduleInstance): string {
  return instance.roleDefinition?.displayName ?? instance.roleDefinitionId;
}

/** Shape of the plain (non-PIM) roleAssignments Graph response used by the P2 fallback below. */
interface PlainRoleAssignment {
  id: string;
  principalId: string;
  roleDefinitionId: string;
  roleDefinition?: { id: string; displayName: string };
}

/** Fetches one account's roles - the per-account unit that getUserDirectoryRolesCore fans out across every resolved account. */
async function fetchRolesForAccount(tenantId: string, user: DirectoryUser): Promise<{ roles: UserRoleEntry[]; pimUnavailable: boolean }> {
  const client = getGraphClient(tenantId);
  const principalFilter = `principalId eq '${user.id}'`;

  try {
    const [activeInstances, eligibleInstances] = await Promise.all([
      fetchRoleAssignmentScheduleInstances(client, principalFilter),
      fetchRoleEligibilityScheduleInstances(client, principalFilter),
    ]);

    const roles: UserRoleEntry[] = [
      ...activeInstances.map((instance) => ({
        roleDefinitionId: instance.roleDefinitionId,
        roleDisplayName: roleDisplayNameOf(instance),
        // roleAssignmentScheduleInstances mixes genuine time-boxed PIM
        // activations (assignmentType: "Activated") with standing/permanent
        // grants that happen to surface through the same endpoint
        // (assignmentType: "Assigned", no end date) - only the former is
        // actually "pim-active".
        assignmentType: instance.assignmentType === "Activated" ? ("pim-active" as const) : ("permanent" as const),
        startDateTime: instance.startDateTime,
        endDateTime: instance.endDateTime,
        account: user.userPrincipalName,
      })),
      ...eligibleInstances.map((instance) => ({
        roleDefinitionId: instance.roleDefinitionId,
        roleDisplayName: roleDisplayNameOf(instance),
        assignmentType: "pim-eligible" as const,
        startDateTime: instance.startDateTime,
        endDateTime: instance.endDateTime,
        account: user.userPrincipalName,
      })),
    ];

    return { roles, pimUnavailable: false };
  } catch (err) {
    // PIM's schedule-instance endpoints (roleAssignmentScheduleInstances /
    // roleEligibilityScheduleInstances) require Entra ID P2 licensing on the
    // tenant. A tenant without P2 doesn't have "no PIM data" - it 403s/400s
    // the whole request. That's a licensing fact about the tenant, not a
    // bug in this call, so per CLAUDE.md's "degrade gracefully" guidance we
    // don't fail the tool: fall back to plain standing role assignments
    // (which every tenant, P2 or not, supports) and flag pimUnavailable so
    // the caller knows PIM-eligible/active state couldn't be checked.
    //
    // Only 403/400 mean "not licensed for this" - anything else (429
    // throttling exhausted, 500, etc.) is a real failure that must not be
    // silently reinterpreted as a licensing gap, so it's rethrown below.
    if (err instanceof GraphError && (err.statusCode === 403 || err.statusCode === 400)) {
      const response = await client
        .api("/roleManagement/directory/roleAssignments")
        .filter(principalFilter)
        .expand("roleDefinition")
        .get();
      const assignments = (response.value as PlainRoleAssignment[]) ?? [];

      const roles: UserRoleEntry[] = assignments.map((assignment) => ({
        roleDefinitionId: assignment.roleDefinitionId,
        roleDisplayName: assignment.roleDefinition?.displayName ?? assignment.roleDefinitionId,
        assignmentType: "permanent" as const,
        account: user.userPrincipalName,
      }));

      return { roles, pimUnavailable: true };
    }

    throw err;
  }
}

/**
 * Fans out fetchRolesForAccount across every account resolveUsers matched
 * and merges the results. A free-text query resolving to more than one
 * account (e.g. a person's standing account plus a separate privileged
 * "(Admin) Name" account) is the whole point of aggregating here rather
 * than erroring - see resolveUsers' cap and reasoning.
 */
export async function getUserDirectoryRolesCore(tenantId: string, users: DirectoryUser[]): Promise<UserDirectoryRolesResult> {
  const perAccount = await Promise.all(users.map((user) => fetchRolesForAccount(tenantId, user)));

  return {
    accountsMatched: users.map((user) => ({ id: user.id, displayName: user.displayName, userPrincipalName: user.userPrincipalName })),
    roles: perAccount.flatMap((result) => result.roles),
    ...(perAccount.some((result) => result.pimUnavailable) ? { pimUnavailable: true as const } : {}),
  };
}

const getUserDirectoryRolesInputShape = {
  userId: z.string().trim().min(2),
  tenant: tenantSelectorField,
};

/**
 * Registers get_user_directory_roles: given a user (by id, UPN, or free-text
 * search via resolveUsers), returns every directory role they hold - whether
 * a permanent standing assignment or, on P2-licensed tenants, a PIM active
 * or eligible assignment. A free-text search that matches more than one
 * account for the same person (e.g. a separate privileged "(Admin) Name"
 * account) returns roles for all of them, each tagged with which account it
 * belongs to, rather than erroring or silently picking one.
 */
export function registerGetUserDirectoryRoles(server: McpServer): void {
  server.registerTool(
    "get_user_directory_roles",
    {
      description:
        "Look up every Entra ID directory role a given user holds - permanent assignments plus, where the tenant supports PIM (Entra ID P2), active and eligible assignments. Accepts a user id, userPrincipalName, or free-text name search. A name search that matches multiple accounts for the same person (e.g. a separate admin account) returns roles for all of them, each tagged with its account.",
      inputSchema: getUserDirectoryRolesInputShape,
    },
    async (args) => {
      return runTool("get_user_directory_roles", args, async () => {
        const tenantId = resolveTenantSelector(args.tenant).tenantId;
        const users = await resolveUsers(tenantId, args.userId);
        return getUserDirectoryRolesCore(tenantId, users);
      });
    },
  );
}
