import { createFakeGraphClient } from "../../helpers/fakeGraphClient";
import { fetchGroupEligibilityScheduleInstances, fetchGroupAssignmentScheduleInstances } from "../../../src/graph/pimGroupSchedules";

describe("pimGroupSchedules", () => {
  it("fetchGroupEligibilityScheduleInstances filters by principal, expands group, and sets Accept-Language", async () => {
    const { client, requests } = createFakeGraphClient([{ data: { value: [] } }]);

    await fetchGroupEligibilityScheduleInstances(client, "principalId eq 'user-1'");

    expect(requests[0].path).toBe("/identityGovernance/privilegedAccess/group/eligibilityScheduleInstances");
    expect(requests[0].filters).toEqual(["principalId eq 'user-1'"]);
    expect(requests[0].expands).toEqual(["group"]);
    expect(requests[0].headers["Accept-Language"]).toBe("en-US");
  });

  it("fetchGroupAssignmentScheduleInstances filters by principal, expands group, and sets Accept-Language", async () => {
    const { client, requests } = createFakeGraphClient([{ data: { value: [] } }]);

    await fetchGroupAssignmentScheduleInstances(client, "principalId eq 'user-1'");

    expect(requests[0].path).toBe("/identityGovernance/privilegedAccess/group/assignmentScheduleInstances");
    expect(requests[0].expands).toEqual(["group"]);
    expect(requests[0].headers["Accept-Language"]).toBe("en-US");
  });

  it("returns the group's expanded displayName inline", async () => {
    const { client } = createFakeGraphClient([
      {
        data: {
          value: [
            {
              id: "instance-1",
              principalId: "user-1",
              groupId: "group-1",
              accessId: "member",
              memberType: "direct",
              startDateTime: "2026-01-01T00:00:00Z",
              endDateTime: "2026-01-01T04:00:00Z",
              group: { id: "group-1", displayName: "SG-AZR-RG-Owner_RG-ClaudeAPI_PIM" },
            },
          ],
        },
      },
    ]);

    const instances = await fetchGroupEligibilityScheduleInstances(client, "principalId eq 'user-1'");

    expect(instances[0].group?.displayName).toBe("SG-AZR-RG-Owner_RG-ClaudeAPI_PIM");
  });
});
