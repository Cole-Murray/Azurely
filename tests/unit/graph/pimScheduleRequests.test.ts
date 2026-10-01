import { createFakeGraphClient } from "../../helpers/fakeGraphClient";
import { fetchAllRoleAssignmentScheduleRequests } from "../../../src/graph/pimScheduleRequests";

describe("fetchAllRoleAssignmentScheduleRequests", () => {
  it("expands roleDefinition and principal on the first request", async () => {
    const { client, requests } = createFakeGraphClient([{ data: { value: [] } }]);

    await fetchAllRoleAssignmentScheduleRequests(client);

    expect(requests[0].path).toBe("/roleManagement/directory/roleAssignmentScheduleRequests");
    expect(requests[0].expands).toEqual(["roleDefinition,principal"]);
  });

  it("follows @odata.nextLink until it's absent, collecting every page", async () => {
    const { client, requests } = createFakeGraphClient([
      { data: { value: [{ id: "req-1" }], "@odata.nextLink": "https://graph.microsoft.com/v1.0/next-page-1" } },
      { data: { value: [{ id: "req-2" }], "@odata.nextLink": "https://graph.microsoft.com/v1.0/next-page-2" } },
      { data: { value: [{ id: "req-3" }] } },
    ]);

    const requestsResult = await fetchAllRoleAssignmentScheduleRequests(client);

    expect(requestsResult.map((r) => r.id)).toEqual(["req-1", "req-2", "req-3"]);
    expect(requests).toHaveLength(3);
    expect(requests[1].path).toBe("https://graph.microsoft.com/v1.0/next-page-1");
    expect(requests[2].path).toBe("https://graph.microsoft.com/v1.0/next-page-2");
  });
});
