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
// Principal-name enrichment (enrichArmPrincipalNames) resolves User/ServicePrincipal
// holders via Graph, even though the assignments themselves come from ARM -
// see arm/principalEnrichment.ts. Must be mocked whenever a test uses a
// "User"/"ServicePrincipal" principalType, or the real getGraphClient runs
// and fails on the fake "tenant-a" id used throughout these Core-level tests.
jest.mock("../../../src/graph/client", () => ({ getGraphClient: jest.fn() }));
jest.mock("../../../src/audit/logger", () => ({ logToolCall: jest.fn() }));

import { logToolCall } from "../../../src/audit/logger";
import { getAuthorizationClient } from "../../../src/arm/client";
import { getAzurePimAssignmentsCore, registerGetAzurePimAssignments } from "../../../src/tools/getAzurePimAssignments";

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

function setUpClient(active: unknown[], eligible: unknown[]) {
  const client = createFakeAuthorizationClient();
  client.roleAssignmentScheduleInstances.listForScope.mockReturnValue(asyncIterableOf(active));
  client.roleEligibilityScheduleInstances.listForScope.mockReturnValue(asyncIterableOf(eligible));
  client.roleDefinitions.list.mockReturnValue(asyncIterableOf([{ name: OWNER_GUID, roleName: "Owner" }]));
  mockGetAuthorizationClient(client);
  return client;
}

describe("getAzurePimAssignmentsCore", () => {
  it("classifies an Activated instance as pim-active and an Assigned one as permanent", async () => {
    setUpClient(
      [
        {
          principalId: "group-1",
          principalType: "Group",
          roleDefinitionId: OWNER_GUID,
          scope: `/subscriptions/${SUB_A}`,
          assignmentType: "Activated",
          startDateTime: new Date("2026-01-01T00:00:00Z"),
          endDateTime: new Date("2026-01-01T04:00:00Z"),
        },
        {
          principalId: "group-2",
          principalType: "Group",
          roleDefinitionId: OWNER_GUID,
          scope: `/subscriptions/${SUB_A}`,
          assignmentType: "Assigned",
        },
      ],
      [],
    );

    const result = await getAzurePimAssignmentsCore("tenant-a", `/subscriptions/${SUB_A}`);

    const active = result.assignments.find((a) => a.principalId === "group-1");
    const permanent = result.assignments.find((a) => a.principalId === "group-2");
    expect(active?.assignmentType).toBe("pim-active");
    expect(active?.startDateTime).toBe("2026-01-01T00:00:00.000Z");
    expect(permanent?.assignmentType).toBe("permanent");
  });

  it("classifies every eligibility instance as pim-eligible", async () => {
    setUpClient([], [{ principalId: "user-1", principalType: "User", roleDefinitionId: OWNER_GUID, scope: `/subscriptions/${SUB_A}` }]);
    queueGraphResponses([{ data: { id: "user-1", displayName: "Alice" } }]);

    const result = await getAzurePimAssignmentsCore("tenant-a", `/subscriptions/${SUB_A}`);

    expect(result.assignments).toEqual([
      expect.objectContaining({ principalId: "user-1", assignmentType: "pim-eligible", roleName: "Owner", principalDisplayName: "Alice" }),
    ]);
  });

  it("degrades a 403'd subscription and still returns the others, flagging accessDeniedForSomeScopes", async () => {
    mockDiscoveredSubscriptions([SUB_A, SUB_B]);

    mockGetAuthorizationClientFn.mockImplementation((_tenantId: string, subscriptionId: string) => {
      if (subscriptionId === SUB_A) {
        const client = createFakeAuthorizationClient();
        client.roleAssignmentScheduleInstances.listForScope.mockImplementation(() => {
          throw new RestError("Forbidden", { statusCode: 403 });
        });
        client.roleEligibilityScheduleInstances.listForScope.mockImplementation(() => {
          throw new RestError("Forbidden", { statusCode: 403 });
        });
        return client;
      }
      const client = createFakeAuthorizationClient();
      client.roleAssignmentScheduleInstances.listForScope.mockReturnValue(
        asyncIterableOf([{ principalId: "group-1", principalType: "Group", roleDefinitionId: OWNER_GUID, scope: `/subscriptions/${SUB_B}`, assignmentType: "Activated" }]),
      );
      client.roleEligibilityScheduleInstances.listForScope.mockReturnValue(asyncIterableOf([]));
      client.roleDefinitions.list.mockReturnValue(asyncIterableOf([{ name: OWNER_GUID, roleName: "Owner" }]));
      return client;
    });

    const result = await getAzurePimAssignmentsCore("tenant-a", undefined);

    expect(result.accessDeniedForSomeScopes).toBe(true);
    expect(result.assignments).toHaveLength(1);
    expect(result.assignments[0].scope).toBe(`/subscriptions/${SUB_B}`);
  });

  it("collapses an inherited active and eligible instance that repeats across every discovered subscription", async () => {
    // Same inherited-scope duplication as getAzureRoleAssignments.test.ts's
    // equivalent test, but for the two PIM schedule-instance endpoints this
    // tool queries in parallel.
    mockDiscoveredSubscriptions([SUB_A, SUB_B]);
    const inheritedActive = {
      id: "/providers/Microsoft.Management/managementGroups/mg-1/.../roleAssignmentScheduleInstances/shared-active",
      principalId: "group-1",
      principalType: "Group",
      roleDefinitionId: OWNER_GUID,
      scope: "/",
      assignmentType: "Activated",
    };
    const inheritedEligible = {
      id: "/providers/Microsoft.Management/managementGroups/mg-1/.../roleEligibilityScheduleInstances/shared-eligible",
      principalId: "group-2",
      principalType: "Group",
      roleDefinitionId: OWNER_GUID,
      scope: "/",
    };
    mockGetAuthorizationClientFn.mockImplementation(() => {
      const client = createFakeAuthorizationClient();
      client.roleAssignmentScheduleInstances.listForScope.mockReturnValue(asyncIterableOf([inheritedActive]));
      client.roleEligibilityScheduleInstances.listForScope.mockReturnValue(asyncIterableOf([inheritedEligible]));
      client.roleDefinitions.list.mockReturnValue(asyncIterableOf([{ name: OWNER_GUID, roleName: "Owner" }]));
      return client;
    });

    const result = await getAzurePimAssignmentsCore("tenant-a", undefined);

    expect(result.assignments.filter((a) => a.principalId === "group-1")).toHaveLength(1);
    expect(result.assignments.filter((a) => a.principalId === "group-2")).toHaveLength(1);
  });

  it("throws when every discovered subscription is denied", async () => {
    mockDiscoveredSubscriptions([SUB_A]);
    const client = createFakeAuthorizationClient();
    client.roleAssignmentScheduleInstances.listForScope.mockImplementation(() => {
      throw new RestError("Forbidden", { statusCode: 403 });
    });
    client.roleEligibilityScheduleInstances.listForScope.mockImplementation(() => {
      throw new RestError("Forbidden", { statusCode: 403 });
    });
    mockGetAuthorizationClient(client);

    await expect(getAzurePimAssignmentsCore("tenant-a", undefined)).rejects.toThrow(/denied every queried scope/);
  });

  it("throws a clear error when no subscriptions are visible at all", async () => {
    mockDiscoveredSubscriptions([]);

    await expect(getAzurePimAssignmentsCore("tenant-a", undefined)).rejects.toThrow(/No Azure subscriptions are visible/);
  });
});

describe("registerGetAzurePimAssignments -> get_azure_pim_assignments", () => {
  it("happy path logs success", async () => {
    setUpClient([], []);

    const handler = captureToolHandler(registerGetAzurePimAssignments, "get_azure_pim_assignments");
    const result = await handler({ scope: `/subscriptions/${SUB_A}` });

    expect(result.isError).toBeUndefined();
    expect(mockLogToolCall).toHaveBeenCalledWith(expect.objectContaining({ tool: "get_azure_pim_assignments", status: "success" }));
  });
});
