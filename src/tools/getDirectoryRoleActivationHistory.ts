import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveTenantSelector, tenantSelectorField } from "./shared/tenantSelector";
import { runTool } from "./shared/runTool";
import { getGraphClient } from "../graph/client";
import { fetchAllRoleAssignmentScheduleInstances, type ScheduleInstance } from "../graph/pimSchedules";
import { resolveServicePrincipalNames } from "../graph/servicePrincipalDirectory";

/**
 * One self-service PIM activation of a directory role - the directory-plane
 * counterpart to get_azure_role_activation_history.
 *
 * SCOPE NOTE (2026-07-28): this originally sourced from
 * roleAssignmentScheduleRequests, which carries the full request-transaction
 * detail (justification, ticket, requestor, approval status). Graph gates
 * that endpoint behind RoleAssignmentSchedule.ReadWrite.Directory even for a
 * plain GET (see CLAUDE.md's "Known open issues" and SECURITY.md §5) - the
 * project decision is that no write-named permission will be requested, ever, so
 * this tool now sources from roleAssignmentScheduleInstances instead, the
 * same current-state endpoint get_user_directory_roles already uses, covered
 * by the already-granted read-only RoleAssignmentSchedule.Read.Directory.
 * That means this tool can report *who* activated *which* role and *when* it
 * started/ended, but never *why* - no justification, no ticket reference, no
 * approver. The fuller implementation (graph/pimScheduleRequests.ts) is
 * still in the repo, unused, in case this permission decision is revisited.
 *
 * SECOND, SEPARATE LIMITATION (found 2026-07-31, see CLAUDE.md's "Known open
 * issues"): roleAssignmentScheduleInstances is a *current-state* endpoint,
 * not an append-only log - fetchAllRoleAssignmentScheduleInstances applies no
 * date filter at all because there is nothing to filter on. Once an
 * activation's endDateTime passes, Graph drops the instance from this
 * endpoint entirely, so this tool can only ever see activations that are
 * still inside their active window at query time - despite the "activation
 * history" name, it is not a historical log and cannot show anything that
 * has already expired, even by a few minutes. get_recent_role_changes (which
 * sources from the real /auditLogs/directoryAudits audit trail) is the tool
 * that actually covers the tenant's full retention window.
 */
export interface DirectoryRoleActivationEntry {
  principalId: string;
  /** Derived from the expanded principal's @odata.type, e.g. "user" | "servicePrincipal" - same convention as getRoleAssignments.ts. */
  principalType: string;
  principalDisplayName?: string;
  roleDefinitionId: string;
  roleDisplayName: string;
  startDateTime?: string;
  endDateTime?: string;
}

export interface DirectoryRoleActivationHistoryResult {
  activations: DirectoryRoleActivationEntry[];
}

function derivePrincipalType(odataType: string | undefined): string {
  if (!odataType) {
    return "unknown";
  }
  return odataType.replace("#microsoft.graph.", "");
}

async function enrichServicePrincipalNames(tenantId: string, entries: DirectoryRoleActivationEntry[]): Promise<void> {
  const unresolved = entries.filter((entry) => entry.principalType === "servicePrincipal" && !entry.principalDisplayName && entry.principalId);
  if (unresolved.length === 0) {
    return;
  }
  const names = await resolveServicePrincipalNames(
    tenantId,
    unresolved.map((entry) => entry.principalId),
  );
  for (const entry of unresolved) {
    const name = names.get(entry.principalId);
    if (name) {
      entry.principalDisplayName = name;
    }
  }
}

function mapInstance(raw: ScheduleInstance): DirectoryRoleActivationEntry {
  return {
    principalId: raw.principal?.id ?? raw.principalId ?? "",
    principalType: derivePrincipalType(raw.principal?.["@odata.type"]),
    principalDisplayName: raw.principal?.displayName,
    roleDefinitionId: raw.roleDefinition?.id ?? raw.roleDefinitionId ?? "",
    roleDisplayName: raw.roleDefinition?.displayName ?? raw.roleDefinitionId ?? "unknown",
    startDateTime: raw.startDateTime,
    endDateTime: raw.endDateTime,
  };
}

export async function getDirectoryRoleActivationHistoryCore(tenantId: string, limit: number | undefined): Promise<DirectoryRoleActivationHistoryResult> {
  const client = getGraphClient(tenantId);
  const raw = await fetchAllRoleAssignmentScheduleInstances(client);

  // "Assigned" is a standing/permanent grant that happens to surface through
  // this same endpoint, not a genuine PIM activation - see ScheduleInstance's
  // assignmentType comment in pimSchedules.ts. Filtered client-side rather
  // than via a server-side $filter=assignmentType eq 'Activated': confirmed
  // live that the filter itself is accepted, but this tenant currently has
  // zero Activated instances, which makes "the filter is accepted" and "the
  // filter silently no-ops" indistinguishable from that one observation -
  // same caution getRecentRoleChanges.ts applies to directoryAudits fields
  // without an independently confirmed server-side filter.
  let activations = raw.filter((instance) => instance.assignmentType === "Activated").map(mapInstance);

  // Most recent activation first - matches get_recent_role_changes'
  // ordering convention for a timeline-shaped result.
  activations.sort((a, b) => (b.startDateTime ?? "").localeCompare(a.startDateTime ?? ""));

  await enrichServicePrincipalNames(tenantId, activations);

  if (limit !== undefined && activations.length > limit) {
    activations = activations.slice(0, limit);
  }

  return { activations };
}

const inputShape = {
  // Optional safety/UX cap. Omit to return every activated instance Graph
  // currently has on record for this tenant.
  limit: z.number().int().min(1).max(10_000).optional(),
  tenant: tenantSelectorField,
};

/**
 * Registers get_directory_role_activation_history: every PIM activation of a
 * directory role currently *still active* - who activated an eligible role,
 * when, for how long. NOT a historical log - see the two scope notes above.
 * Does not include justification, ticket reference, or approval status.
 */
export function registerGetDirectoryRoleActivationHistory(server: McpServer): void {
  server.registerTool(
    "get_directory_role_activation_history",
    {
      description:
        "List PIM activations of Entra ID directory roles (Global Administrator, etc.) that are still within their active window right now - who activated an eligible role, when, and for how long. IMPORTANT: this is a current-state snapshot, not a historical log - it sources from Graph's roleAssignmentScheduleInstances endpoint, which drops an activation the moment its end time passes, so this tool cannot see anything that has already expired (even a few minutes ago), regardless of how far back you'd like to look. For a true historical view of role activity across the tenant's audit retention window (up to 30 days), including expired activations, use get_recent_role_changes instead. Most recent first. Pass limit to cap how many entries are returned. Does not include justification, ticket reference, or approver - Graph gates that detail behind a permission this app registration deliberately doesn't hold (see CLAUDE.md's Known open issues).",
      inputSchema: inputShape,
    },
    async (args) => {
      return runTool("get_directory_role_activation_history", args, async () => {
        const tenantId = resolveTenantSelector(args.tenant).tenantId;
        return getDirectoryRoleActivationHistoryCore(tenantId, args.limit);
      });
    },
  );
}
