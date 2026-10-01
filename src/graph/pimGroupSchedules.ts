import type { Client } from "@microsoft/microsoft-graph-client";

/**
 * PIM for Groups: eligibility/active membership or ownership of a security
 * group governed by PIM. Distinct from both the directory-role PIM
 * (pimSchedules.ts) and Azure-resource PIM (arm/) surfaces - this is a third,
 * Graph-hosted schedule-instance API
 * (/identityGovernance/privilegedAccess/group/...), used here because a
 * common enterprise pattern grants an Azure RBAC role to a *group* and puts
 * that group's membership under PIM, rather than PIM-governing the Azure
 * role assignment directly (see get_user_group_pim_eligibility).
 *
 * Field casing is intentionally NOT normalized to match the directory-role
 * or ARM PIM surfaces: Graph documents this API's own memberType/accessId/
 * assignmentType values as lowercase ("direct", "group", "member", "owner",
 * "assigned", "activated"), unlike the capitalized values on those other two
 * surfaces. Verify against Graph Explorer before relying on any field here.
 */
export interface GroupScheduleInstance {
  id: string;
  principalId: string;
  groupId: string;
  /** "member" | "owner" */
  accessId?: string;
  /** "direct" | "group" | "unknownFutureValue" */
  memberType?: string;
  startDateTime?: string;
  endDateTime?: string;
  /** Populated via $expand=group - see fetchers below. Absent group.displayName means Group.Read.All hasn't resolved it (e.g. not yet consented, or the group was deleted). */
  group?: { id?: string; displayName?: string };
}

/** Only present on assignment (active) instances, never on eligibility instances - "assigned" is a standing/permanent membership, "activated" is a genuine time-boxed PIM activation. */
export interface GroupAssignmentScheduleInstance extends GroupScheduleInstance {
  assignmentType?: string;
}

// Same defensive header pimSchedules.ts applies to the directory-role PIM
// endpoints (Node's global fetch sends "Accept-Language: *" when unset,
// which some Graph endpoints reject with a 400 that's indistinguishable from
// a real failure at the statusCode level). Not yet confirmed whether this
// specific /identityGovernance subtree has the same behavior - kept for
// defense in depth and worth confirming in Graph Explorer before removing.
const ACCEPT_LANGUAGE = "en-US";

export async function fetchGroupEligibilityScheduleInstances(client: Client, filter: string): Promise<GroupScheduleInstance[]> {
  const response = await client
    .api("/identityGovernance/privilegedAccess/group/eligibilityScheduleInstances")
    .header("Accept-Language", ACCEPT_LANGUAGE)
    .filter(filter)
    .expand("group")
    .get();
  return response.value as GroupScheduleInstance[];
}

export async function fetchGroupAssignmentScheduleInstances(client: Client, filter: string): Promise<GroupAssignmentScheduleInstance[]> {
  const response = await client
    .api("/identityGovernance/privilegedAccess/group/assignmentScheduleInstances")
    .header("Accept-Language", ACCEPT_LANGUAGE)
    .filter(filter)
    .expand("group")
    .get();
  return response.value as GroupAssignmentScheduleInstance[];
}
