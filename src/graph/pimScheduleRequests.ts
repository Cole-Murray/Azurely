import type { Client } from "@microsoft/microsoft-graph-client";

/**
 * NOT CURRENTLY USED by any registered tool (as of 2026-07-28). Kept in the
 * repo as the concrete implementation of the fuller directory-role
 * activation history (justification/ticket/requestor/approval status) in
 * case the permission decision below is ever revisited - deleting it would
 * lose that work with nothing to show what "the fuller version" actually
 * looked like. get_directory_role_activation_history sources from
 * graph/pimSchedules.ts's fetchAllRoleAssignmentScheduleInstances instead;
 * see the scope note at the top of tools/getDirectoryRoleActivationHistory.ts,
 * CLAUDE.md's "Known open issues", and SECURITY.md §5 for the full story.
 *
 * Shape trimmed to the fields get_directory_role_activation_history uses.
 * Verify against a live response in Graph Explorer (aka.ms/ge) before relying
 * on any field not listed here.
 *
 * Requires RoleAssignmentSchedule.ReadWrite.Directory, NOT the read-only
 * RoleAssignmentSchedule.Read.Directory already granted for the PIM
 * schedule-instance endpoints (pimSchedules.ts) - confirmed against
 * Microsoft's own permissions tables while building this tool. That narrower
 * permission only covers roleAssignmentSchedules/roleAssignmentScheduleInstances
 * (current-state endpoints); the request-transaction detail this tool
 * surfaces (justification, ticket, requestor, approval status) lives only on
 * roleAssignmentScheduleRequests, which Graph gates behind the
 * ReadWrite-named permission even for GET. This is a deliberate, flagged
 * exception to this project's least-privilege stance - see SECURITY.md.
 */
export interface RoleAssignmentScheduleRequest {
  id: string;
  status?: string;
  createdDateTime?: string;
  /** e.g. "selfActivate" (what this tool filters to), "adminAssign", "selfDeactivate", etc. */
  action?: string;
  principalId?: string;
  principal?: { id?: string; displayName?: string; "@odata.type"?: string };
  roleDefinitionId?: string;
  roleDefinition?: { id: string; displayName: string };
  justification?: string;
  scheduleInfo?: {
    startDateTime?: string;
    expiration?: { type?: string; endDateTime?: string; duration?: string };
  };
  ticketInfo?: { ticketNumber?: string; ticketSystem?: string };
}

interface RoleAssignmentScheduleRequestsPage {
  value?: RoleAssignmentScheduleRequest[];
  "@odata.nextLink"?: string;
}

/**
 * Fetches every roleAssignmentScheduleRequest by following @odata.nextLink -
 * same pagination discipline as fetchAllDirectoryAuditPages in
 * getRecentRoleChanges.ts, since a single Graph response is only one page.
 *
 * Unlike directoryAudits, this endpoint's retention behavior for older
 * request records is undocumented as of writing - do not assume the same
 * 30-day ceiling audit logs have without confirming it live against a real
 * tenant first.
 */
export async function fetchAllRoleAssignmentScheduleRequests(client: Client): Promise<RoleAssignmentScheduleRequest[]> {
  const requests: RoleAssignmentScheduleRequest[] = [];

  let response: RoleAssignmentScheduleRequestsPage = await client
    .api("/roleManagement/directory/roleAssignmentScheduleRequests")
    .expand("roleDefinition,principal")
    .get();
  requests.push(...(response.value ?? []));

  while (response["@odata.nextLink"]) {
    const nextLink = response["@odata.nextLink"];
    console.error(`[pimScheduleRequests] following nextLink (collected ${requests.length} entries so far)`);
    response = await client.api(nextLink).get();
    requests.push(...(response.value ?? []));
  }

  return requests;
}
