import { RestError } from "@azure/core-rest-pipeline";
import { resetEnvCacheForTests } from "../../../src/config/env";
import { clearAzureRoleDefinitionsCacheForTests } from "../../../src/cache/azureRoleDefinitionsCache";
import { clearServicePrincipalCacheForTests } from "../../../src/graph/servicePrincipalDirectory";
import { clearUserNameCacheForTests } from "../../../src/graph/userDirectory";
import { queueGraphResponses } from "../../helpers/fakeGraphClient";
import { captureToolHandler } from "../../helpers/mcpTestServer";
import { createFakeAuthorizationClient, mockGetAuthorizationClient, mockDiscoveredSubscriptions, asyncIterableOf } from "../../helpers/fakeArmClient";

jest.mock("../../../src/arm/client", () => ({
  getAuthorizationClient: jest.fn(),
  getSubscriptionClient: jest.fn(),
}));
// See the identical comment in getAzurePimAssignments.test.ts: principal-name
// enrichment resolves User/ServicePrincipal holders via Graph even though the
// assignments themselves come from ARM.
jest.mock("../../../src/graph/client", () => ({ getGraphClient: jest.fn() }));
jest.mock("../../../src/audit/logger", () => ({ logToolCall: jest.fn() }));

import { logToolCall } from "../../../src/audit/logger";
import { getAuthorizationClient } from "../../../src/arm/client";
import { getAzureRoleActivationHistoryCore, registerGetAzureRoleActivationHistory } from "../../../src/tools/getAzureRoleActivationHistory";

const OWNER_GUID = "8e3af657-a8ff-443c-a75c-2fe8c4bcb635";
const SUB_A = "11111111-1111-1111-1111-111111111111";
const SUB_B = "22222222-2222-2222-2222-222222222222";
const mockLogToolCall = logToolCall as jest.Mock;
const mockGetAuthorizationClientFn = getAuthorizationClient as jest.Mock;

const originalEnv = { ...process.env };

beforeEach(() => {
  jest.clearAllMocks();
  clearAzureRoleDefinitionsCacheForTests();
  clearServicePrincipalCacheForTests();
  clearUserNameCacheForTests();
  resetEnvCacheForTests();
  process.env.AZURE_TENANT_ID = SUB_A;
  process.env.AZURE_CLIENT_ID = "22222222-2222-2222-2222-222222222222";
  process.env.AZURE_CLIENT_SECRET = "fake-secret";
});

afterEach(() => {
  process.env = { ...originalEnv };
  resetEnvCacheForTests();
});

function setUpClient(requests: unknown[]) {
  const client = createFakeAuthorizationClient();
  client.roleAssignmentScheduleRequests.listForScope.mockReturnValue(asyncIterableOf(requests));
  client.roleDefinitions.list.mockReturnValue(asyncIterableOf([{ name: OWNER_GUID, roleName: "Owner" }]));
  mockGetAuthorizationClient(client);
  return client;
}

describe("getAzureRoleActivationHistoryCore", () => {
  it("keeps only SelfActivate requests and maps justification/ticket/schedule detail", async () => {
    setUpClient([
      {
        principalId: "user-1",
        principalType: "User",
        roleDefinitionId: OWNER_GUID,
        scope: `/subscriptions/${SUB_A}`,
        requestType: "SelfActivate",
        status: "Provisioned",
        justification: "Investigating an incident",
        ticketInfo: { ticketNumber: "INC-123", ticketSystem: "ServiceNow" },
        createdOn: new Date("2026-01-01T00:00:00Z"),
        scheduleInfo: { startDateTime: new Date("2026-01-01T00:00:00Z"), expiration: { endDateTime: new Date("2026-01-01T04:00:00Z") } },
      },
      {
        principalId: "user-2",
        principalType: "User",
        roleDefinitionId: OWNER_GUID,
        scope: `/subscriptions/${SUB_A}`,
        requestType: "AdminAssign",
      },
    ]);
    queueGraphResponses([{ data: { id: "user-1", displayName: "Alice" } }]);

    const result = await getAzureRoleActivationHistoryCore("tenant-a", `/subscriptions/${SUB_A}`);

    expect(result.activations).toHaveLength(1);
    expect(result.activations[0]).toEqual(
      expect.objectContaining({
        principalId: "user-1",
        principalDisplayName: "Alice",
        roleName: "Owner",
        status: "Provisioned",
        justification: "Investigating an incident",
        ticketNumber: "INC-123",
        ticketSystem: "ServiceNow",
        requestedDateTime: "2026-01-01T00:00:00.000Z",
        startDateTime: "2026-01-01T00:00:00.000Z",
        endDateTime: "2026-01-01T04:00:00.000Z",
      }),
    );
  });

  it("computes endDateTime from an AfterDuration expiration when Azure omits an explicit endDateTime", async () => {
    setUpClient([
      {
        principalId: "user-1",
        principalType: "User",
        roleDefinitionId: OWNER_GUID,
        scope: `/subscriptions/${SUB_A}`,
        requestType: "SelfActivate",
        scheduleInfo: {
          startDateTime: new Date("2026-01-01T00:00:00Z"),
          expiration: { type: "AfterDuration", duration: "PT4H" },
        },
      },
    ]);
    queueGraphResponses([{ data: { id: "user-1", displayName: "Alice" } }]);

    const result = await getAzureRoleActivationHistoryCore("tenant-a", `/subscriptions/${SUB_A}`);

    expect(result.activations[0].startDateTime).toBe("2026-01-01T00:00:00.000Z");
    expect(result.activations[0].endDateTime).toBe("2026-01-01T04:00:00.000Z");
  });

  it("degrades a 403'd subscription and still returns the others, flagging accessDeniedForSomeScopes", async () => {
    mockDiscoveredSubscriptions([SUB_A, SUB_B]);

    mockGetAuthorizationClientFn.mockImplementation((_tenantId: string, subscriptionId: string) => {
      if (subscriptionId === SUB_A) {
        const client = createFakeAuthorizationClient();
        client.roleAssignmentScheduleRequests.listForScope.mockImplementation(() => {
          throw new RestError("Forbidden", { statusCode: 403 });
        });
        return client;
      }
      const client = createFakeAuthorizationClient();
      client.roleAssignmentScheduleRequests.listForScope.mockReturnValue(
        asyncIterableOf([
          { principalId: "user-1", principalType: "User", roleDefinitionId: OWNER_GUID, scope: `/subscriptions/${SUB_B}`, requestType: "SelfActivate" },
        ]),
      );
      client.roleDefinitions.list.mockReturnValue(asyncIterableOf([{ name: OWNER_GUID, roleName: "Owner" }]));
      return client;
    });
    queueGraphResponses([{ data: { id: "user-1", displayName: "Alice" } }]);

    const result = await getAzureRoleActivationHistoryCore("tenant-a", undefined);

    expect(result.accessDeniedForSomeScopes).toBe(true);
    expect(result.activations).toHaveLength(1);
    expect(result.activations[0].scope).toBe(`/subscriptions/${SUB_B}`);
  });

  it("collapses an inherited activation request that repeats across every discovered subscription", async () => {
    // Same inherited-scope duplication as getAzureRoleAssignments.test.ts's
    // equivalent test, but for roleAssignmentScheduleRequests.
    mockDiscoveredSubscriptions([SUB_A, SUB_B]);
    const inheritedRequest = {
      id: "/providers/Microsoft.Management/managementGroups/mg-1/.../roleAssignmentScheduleRequests/shared-guid",
      principalId: "group-1",
      principalType: "Group",
      roleDefinitionId: OWNER_GUID,
      scope: "/",
      requestType: "SelfActivate",
    };
    mockGetAuthorizationClientFn.mockImplementation(() => {
      const client = createFakeAuthorizationClient();
      client.roleAssignmentScheduleRequests.listForScope.mockReturnValue(asyncIterableOf([inheritedRequest]));
      client.roleDefinitions.list.mockReturnValue(asyncIterableOf([{ name: OWNER_GUID, roleName: "Owner" }]));
      return client;
    });

    const result = await getAzureRoleActivationHistoryCore("tenant-a", undefined);

    expect(result.activations).toHaveLength(1);
  });

  it("throws when every discovered subscription is denied", async () => {
    mockDiscoveredSubscriptions([SUB_A]);
    const client = createFakeAuthorizationClient();
    client.roleAssignmentScheduleRequests.listForScope.mockImplementation(() => {
      throw new RestError("Forbidden", { statusCode: 403 });
    });
    mockGetAuthorizationClient(client);

    await expect(getAzureRoleActivationHistoryCore("tenant-a", undefined)).rejects.toThrow(/denied every queried scope/);
  });

  it("throws a clear error when no subscriptions are visible at all", async () => {
    mockDiscoveredSubscriptions([]);

    await expect(getAzureRoleActivationHistoryCore("tenant-a", undefined)).rejects.toThrow(/No Azure subscriptions are visible/);
  });
});

describe("registerGetAzureRoleActivationHistory -> get_azure_role_activation_history", () => {
  it("happy path logs success", async () => {
    setUpClient([]);

    const handler = captureToolHandler(registerGetAzureRoleActivationHistory, "get_azure_role_activation_history");
    const result = await handler({ scope: `/subscriptions/${SUB_A}` });

    expect(result.isError).toBeUndefined();
    expect(mockLogToolCall).toHaveBeenCalledWith(expect.objectContaining({ tool: "get_azure_role_activation_history", status: "success" }));
  });
});
