import { createFakeGraphClient } from "../../helpers/fakeGraphClient";
import { fetchRoleAssignmentScheduleInstances, fetchRoleEligibilityScheduleInstances, fetchAllRoleAssignmentScheduleInstances } from "../../../src/graph/pimSchedules";

// Root cause of a real production bug: Node's global fetch (which
// @microsoft/microsoft-graph-client's HTTPMessageHandler calls internally)
// sends "Accept-Language: *" by default when no explicit header is set.
// Graph's PIM schedule-instance endpoints reject that wildcard with a 400
// CultureNotFoundException, which get_user_directory_roles' fallback logic
// then misreads as "tenant lacks Entra ID P2 licensing" - a licensing
// message with nothing to do with actual licensing. These calls must set an
// explicit Accept-Language so the wildcard never reaches Graph.
describe("pimSchedules Accept-Language header", () => {
  it("fetchRoleAssignmentScheduleInstances sets an explicit Accept-Language header", async () => {
    const { client, requests } = createFakeGraphClient([{ data: { value: [] } }]);

    await fetchRoleAssignmentScheduleInstances(client, "principalId eq 'x'");

    expect(requests[0].headers["Accept-Language"]).toBe("en-US");
  });

  it("fetchRoleEligibilityScheduleInstances sets an explicit Accept-Language header", async () => {
    const { client, requests } = createFakeGraphClient([{ data: { value: [] } }]);

    await fetchRoleEligibilityScheduleInstances(client, "principalId eq 'x'");

    expect(requests[0].headers["Accept-Language"]).toBe("en-US");
  });

  it("fetchAllRoleAssignmentScheduleInstances sets an explicit Accept-Language header too", async () => {
    const { client, requests } = createFakeGraphClient([{ data: { value: [] } }]);

    await fetchAllRoleAssignmentScheduleInstances(client);

    expect(requests[0].headers["Accept-Language"]).toBe("en-US");
  });
});

describe("fetchAllRoleAssignmentScheduleInstances", () => {
  it("expands roleDefinition and principal, unfiltered, on the first request", async () => {
    const { client, requests } = createFakeGraphClient([{ data: { value: [] } }]);

    await fetchAllRoleAssignmentScheduleInstances(client);

    expect(requests[0].path).toBe("/roleManagement/directory/roleAssignmentScheduleInstances");
    expect(requests[0].expands).toEqual(["roleDefinition,principal"]);
    expect(requests[0].filters).toEqual([]);
  });

  it("follows @odata.nextLink until it's absent, collecting every page", async () => {
    // get_directory_role_activation_history needs every instance tenant-wide
    // to build a timeline (unlike fetchRoleAssignmentScheduleInstances above,
    // which is always scoped to one principal/role and so safely fits on one
    // page) - same pagination discipline as fetchAllRoleAssignmentScheduleRequests.
    const { client, requests } = createFakeGraphClient([
      { data: { value: [{ id: "inst-1" }], "@odata.nextLink": "https://graph.microsoft.com/v1.0/next-page-1" } },
      { data: { value: [{ id: "inst-2" }], "@odata.nextLink": "https://graph.microsoft.com/v1.0/next-page-2" } },
      { data: { value: [{ id: "inst-3" }] } },
    ]);

    const result = await fetchAllRoleAssignmentScheduleInstances(client);

    expect(result.map((i) => i.id)).toEqual(["inst-1", "inst-2", "inst-3"]);
    expect(requests).toHaveLength(3);
    expect(requests[1].path).toBe("https://graph.microsoft.com/v1.0/next-page-1");
    expect(requests[2].path).toBe("https://graph.microsoft.com/v1.0/next-page-2");
  });
});
