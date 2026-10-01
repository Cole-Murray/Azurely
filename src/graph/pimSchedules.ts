import type { Client } from "@microsoft/microsoft-graph-client";

/**
 * Shape trimmed to the fields these tools actually use. Verify against a
 * live response in Graph Explorer (aka.ms/ge) before relying on any field
 * not listed here - PIM's schedule-instance endpoints require Entra ID P2
 * licensing, and a tenant without P2 will 403/400 on these calls entirely
 * (callers must handle that, see getUserDirectoryRoles.ts).
 */
export interface ScheduleInstance {
  id: string;
  principalId: string;
  roleDefinitionId: string;
  roleDefinition?: { id: string; displayName: string };
  startDateTime?: string;
  endDateTime?: string;
  // "Activated" is a genuine time-boxed PIM activation of an eligible role.
  // "Assigned" is a standing/permanent grant that happens to surface through
  // this same endpoint - not time-boxed, not PIM-governed. Callers must not
  // treat every entry here as "PIM-active" without checking this field.
  assignmentType?: "Assigned" | "Activated";
  /** Only populated when the caller expands "principal" - see fetchAllRoleAssignmentScheduleInstances below. Absent for the single-principal/single-role callers above, which don't need it (they already know who they filtered for). */
  principal?: { id?: string; displayName?: string; "@odata.type"?: string };
}

/**
 * Both PIM schedule-instance endpoints take an arbitrary OData $filter
 * rather than a fixed "by user" or "by role" shape, so the same function
 * serves get_user_directory_roles (filter by principalId) and
 * assess_role_risk (filter by roleDefinitionId) without either one needing
 * a second, near-duplicate Graph call.
 */
// Node's global fetch (which the Graph SDK's HTTPMessageHandler calls
// internally) sends "Accept-Language: *" whenever no explicit header is
// set. These two schedule-instance endpoints reject that wildcard with a
// 400 CultureNotFoundException - which looks identical, at the statusCode
// level, to a genuine "tenant lacks P2 licensing" response. Setting an
// explicit language here keeps the wildcard from ever reaching Graph.
const ACCEPT_LANGUAGE = "en-US";

export async function fetchRoleAssignmentScheduleInstances(client: Client, filter: string): Promise<ScheduleInstance[]> {
  const response = await client
    .api("/roleManagement/directory/roleAssignmentScheduleInstances")
    .header("Accept-Language", ACCEPT_LANGUAGE)
    .filter(filter)
    .expand("roleDefinition")
    .get();
  return response.value as ScheduleInstance[];
}

export async function fetchRoleEligibilityScheduleInstances(client: Client, filter: string): Promise<ScheduleInstance[]> {
  const response = await client
    .api("/roleManagement/directory/roleEligibilityScheduleInstances")
    .header("Accept-Language", ACCEPT_LANGUAGE)
    .filter(filter)
    .expand("roleDefinition")
    .get();
  return response.value as ScheduleInstance[];
}

interface ScheduleInstancesPage {
  value?: ScheduleInstance[];
  "@odata.nextLink"?: string;
}

/**
 * Fetches every roleAssignmentScheduleInstance in the tenant - no filter,
 * $expand=roleDefinition,principal - following @odata.nextLink to collect
 * every page. Backs get_directory_role_activation_history, which needs a
 * tenant-wide timeline rather than one principal's or one role's instances,
 * so (unlike fetchRoleAssignmentScheduleInstances above, always called with
 * a narrow filter) pagination can't be skipped here. Same discipline as
 * fetchAllRoleAssignmentScheduleRequests in pimScheduleRequests.ts.
 *
 * get_directory_role_activation_history originally sourced from
 * roleAssignmentScheduleRequests instead, which carries full request-
 * transaction detail (justification, ticket, requestor, approval status) -
 * but Graph gates that behind RoleAssignmentSchedule.ReadWrite.Directory even
 * for GET, and that permission was declined (see CLAUDE.md's "Known open
 * issues" and SECURITY.md §5). This endpoint is covered by the
 * already-granted read-only RoleAssignmentSchedule.Read.Directory instead,
 * at the cost of that request-transaction detail - it can report who
 * activated which role and when, not why.
 */
export async function fetchAllRoleAssignmentScheduleInstances(client: Client): Promise<ScheduleInstance[]> {
  const instances: ScheduleInstance[] = [];

  let response: ScheduleInstancesPage = await client
    .api("/roleManagement/directory/roleAssignmentScheduleInstances")
    .header("Accept-Language", ACCEPT_LANGUAGE)
    .expand("roleDefinition,principal")
    .get();
  instances.push(...(response.value ?? []));

  while (response["@odata.nextLink"]) {
    const nextLink = response["@odata.nextLink"];
    console.error(`[pimSchedules] following nextLink (collected ${instances.length} entries so far)`);
    response = await client.api(nextLink).get();
    instances.push(...(response.value ?? []));
  }

  return instances;
}
