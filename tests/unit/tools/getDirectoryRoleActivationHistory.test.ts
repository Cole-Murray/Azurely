import { resetEnvCacheForTests } from "../../../src/config/env";
import { clearServicePrincipalCacheForTests } from "../../../src/graph/servicePrincipalDirectory";
import { queueGraphResponses } from "../../helpers/fakeGraphClient";
import { captureToolHandler } from "../../helpers/mcpTestServer";

jest.mock("../../../src/graph/client", () => ({ getGraphClient: jest.fn() }));
jest.mock("../../../src/audit/logger", () => ({ logToolCall: jest.fn() }));

import { logToolCall } from "../../../src/audit/logger";
import { getDirectoryRoleActivationHistoryCore, registerGetDirectoryRoleActivationHistory } from "../../../src/tools/getDirectoryRoleActivationHistory";

const mockLogToolCall = logToolCall as jest.Mock;
const originalEnv = { ...process.env };

beforeEach(() => {
  jest.clearAllMocks();
  clearServicePrincipalCacheForTests();
  resetEnvCacheForTests();
  process.env.AZURE_TENANT_ID = "11111111-1111-1111-1111-111111111111";
  process.env.AZURE_CLIENT_ID = "22222222-2222-2222-2222-222222222222";
  process.env.AZURE_CLIENT_SECRET = "fake-secret";
});

afterEach(() => {
  process.env = { ...originalEnv };
  resetEnvCacheForTests();
});

// This tool sources from roleAssignmentScheduleInstances, not
// roleAssignmentScheduleRequests - see the scope-note comment at the top of
// src/tools/getDirectoryRoleActivationHistory.ts for why. That means no
// justification/ticket/requestor/approval-status fields - only who activated
// which role, and when it started/ended.
describe("getDirectoryRoleActivationHistoryCore", () => {
  it("keeps only Activated instances and maps principal/role/schedule detail", async () => {
    queueGraphResponses([
      {
        data: {
          value: [
            {
              id: "inst-1",
              assignmentType: "Activated",
              principal: { id: "user-1", displayName: "Alice", "@odata.type": "#microsoft.graph.user" },
              roleDefinition: { id: "role-1", displayName: "Global Administrator" },
              startDateTime: "2026-01-01T00:00:00Z",
              endDateTime: "2026-01-01T04:00:00Z",
            },
            {
              id: "inst-2",
              // A standing/permanent grant that happens to surface through
              // this same endpoint - not a genuine PIM activation, must be
              // excluded from an "activation history" result.
              assignmentType: "Assigned",
              principal: { id: "user-2", displayName: "Bob", "@odata.type": "#microsoft.graph.user" },
              roleDefinition: { id: "role-1", displayName: "Global Administrator" },
            },
          ],
        },
      },
    ]);

    const result = await getDirectoryRoleActivationHistoryCore("tenant-a", undefined);

    expect(result.activations).toHaveLength(1);
    expect(result.activations[0]).toEqual({
      principalId: "user-1",
      principalType: "user",
      principalDisplayName: "Alice",
      roleDefinitionId: "role-1",
      roleDisplayName: "Global Administrator",
      startDateTime: "2026-01-01T00:00:00Z",
      endDateTime: "2026-01-01T04:00:00Z",
    });
  });

  it("orders activations most-recent-first by startDateTime", async () => {
    queueGraphResponses([
      {
        data: {
          value: [
            {
              id: "inst-old",
              assignmentType: "Activated",
              principal: { id: "user-1", displayName: "Alice", "@odata.type": "#microsoft.graph.user" },
              roleDefinition: { id: "role-1", displayName: "Global Administrator" },
              startDateTime: "2026-01-01T00:00:00Z",
            },
            {
              id: "inst-new",
              assignmentType: "Activated",
              principal: { id: "user-1", displayName: "Alice", "@odata.type": "#microsoft.graph.user" },
              roleDefinition: { id: "role-1", displayName: "Global Administrator" },
              startDateTime: "2026-06-01T00:00:00Z",
            },
          ],
        },
      },
    ]);

    const result = await getDirectoryRoleActivationHistoryCore("tenant-a", undefined);

    expect(result.activations.map((a) => a.startDateTime)).toEqual(["2026-06-01T00:00:00Z", "2026-01-01T00:00:00Z"]);
  });

  it("resolves a service principal's display name when Graph returns it as a bare GUID", async () => {
    queueGraphResponses([
      {
        data: {
          value: [
            {
              id: "inst-1",
              assignmentType: "Activated",
              principal: { id: "sp-1", "@odata.type": "#microsoft.graph.servicePrincipal" },
              roleDefinition: { id: "role-1", displayName: "Global Administrator" },
            },
          ],
        },
      },
      { data: { id: "sp-1", displayName: "Automation Service" } },
    ]);

    const result = await getDirectoryRoleActivationHistoryCore("tenant-a", undefined);

    expect(result.activations[0].principalDisplayName).toBe("Automation Service");
  });

  it("applies limit after sorting", async () => {
    queueGraphResponses([
      {
        data: {
          value: [
            {
              id: "inst-1",
              assignmentType: "Activated",
              principal: { id: "u1", "@odata.type": "#microsoft.graph.user" },
              roleDefinition: { id: "r", displayName: "R" },
              startDateTime: "2026-01-01T00:00:00Z",
            },
            {
              id: "inst-2",
              assignmentType: "Activated",
              principal: { id: "u2", "@odata.type": "#microsoft.graph.user" },
              roleDefinition: { id: "r", displayName: "R" },
              startDateTime: "2026-02-01T00:00:00Z",
            },
          ],
        },
      },
    ]);

    const result = await getDirectoryRoleActivationHistoryCore("tenant-a", 1);

    expect(result.activations).toHaveLength(1);
    expect(result.activations[0].startDateTime).toBe("2026-02-01T00:00:00Z");
  });
});

describe("registerGetDirectoryRoleActivationHistory -> get_directory_role_activation_history", () => {
  it("happy path logs success", async () => {
    queueGraphResponses([{ data: { value: [] } }]);

    const handler = captureToolHandler(registerGetDirectoryRoleActivationHistory, "get_directory_role_activation_history");
    const result = await handler({});

    expect(result.isError).toBeUndefined();
    expect(mockLogToolCall).toHaveBeenCalledWith(expect.objectContaining({ tool: "get_directory_role_activation_history", status: "success" }));
  });
});
