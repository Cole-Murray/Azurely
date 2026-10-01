import { RestError } from "@azure/core-rest-pipeline";
import { resetEnvCacheForTests } from "../../../src/config/env";
import { clearAzureRoleDefinitionsCacheForTests } from "../../../src/cache/azureRoleDefinitionsCache";
import { clearServicePrincipalCacheForTests } from "../../../src/graph/servicePrincipalDirectory";
import { clearUserNameCacheForTests } from "../../../src/graph/userDirectory";
import { captureToolHandler } from "../../helpers/mcpTestServer";
import { createFakeAuthorizationClient, mockGetAuthorizationClient, mockDiscoveredSubscriptions, asyncIterableOf } from "../../helpers/fakeArmClient";

jest.mock("../../../src/arm/client", () => ({
  getAuthorizationClient: jest.fn(),
  getSubscriptionClient: jest.fn(),
}));
jest.mock("../../../src/audit/logger", () => ({ logToolCall: jest.fn() }));

import { logToolCall } from "../../../src/audit/logger";
import { getAuthorizationClient } from "../../../src/arm/client";
import { getAzureRoleAssignmentsCore, registerGetAzureRoleAssignments } from "../../../src/tools/getAzureRoleAssignments";

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

function fakeClientWithAssignments(assignments: unknown[]) {
  const client = createFakeAuthorizationClient();
  client.roleAssignments.listForScope.mockReturnValue(asyncIterableOf(assignments));
  client.roleDefinitions.list.mockReturnValue(asyncIterableOf([{ name: OWNER_GUID, roleName: "Owner" }]));
  return client;
}

describe("getAzureRoleAssignmentsCore", () => {
  it("resolves the role name and leaves a Group principal's display name unresolved", async () => {
    mockGetAuthorizationClient(
      fakeClientWithAssignments([
        {
          principalId: "group-1",
          principalType: "Group",
          roleDefinitionId: `/subscriptions/${SUB_A}/providers/Microsoft.Authorization/roleDefinitions/${OWNER_GUID}`,
          scope: `/subscriptions/${SUB_A}`,
        },
      ]),
    );

    const result = await getAzureRoleAssignmentsCore("tenant-a", `/subscriptions/${SUB_A}`, undefined);

    expect(result.assignments).toEqual([
      {
        principalId: "group-1",
        principalType: "Group",
        roleDefinitionId: OWNER_GUID,
        roleName: "Owner",
        scope: `/subscriptions/${SUB_A}`,
      },
    ]);
    expect(result.scopesQueried).toEqual([`/subscriptions/${SUB_A}`]);
    expect(result.accessDeniedForSomeScopes).toBeUndefined();
  });

  it("filters by roleName case-insensitively", async () => {
    const client = fakeClientWithAssignments([
      { principalId: "group-1", principalType: "Group", roleDefinitionId: OWNER_GUID, scope: `/subscriptions/${SUB_A}` },
    ]);
    client.roleDefinitions.list.mockReturnValue(
      asyncIterableOf([
        { name: OWNER_GUID, roleName: "Owner" },
      ]),
    );
    mockGetAuthorizationClient(client);

    const matches = await getAzureRoleAssignmentsCore("tenant-a", `/subscriptions/${SUB_A}`, "owner");
    expect(matches.assignments).toHaveLength(1);

    const noMatches = await getAzureRoleAssignmentsCore("tenant-a", `/subscriptions/${SUB_A}`, "contributor");
    expect(noMatches.assignments).toHaveLength(0);
  });

  it("degrades a 403'd subscription and still returns the others, flagging accessDeniedForSomeScopes", async () => {
    mockDiscoveredSubscriptions([SUB_A, SUB_B]);

    mockGetAuthorizationClientFn.mockImplementation((_tenantId: string, subscriptionId: string) => {
      if (subscriptionId === SUB_A) {
        const client = createFakeAuthorizationClient();
        client.roleAssignments.listForScope.mockImplementation(() => {
          throw new RestError("Forbidden", { statusCode: 403 });
        });
        return client;
      }
      return fakeClientWithAssignments([
        { principalId: "group-1", principalType: "Group", roleDefinitionId: OWNER_GUID, scope: `/subscriptions/${SUB_B}` },
      ]);
    });

    const result = await getAzureRoleAssignmentsCore("tenant-a", undefined, undefined);

    expect(result.accessDeniedForSomeScopes).toBe(true);
    expect(result.assignments).toHaveLength(1);
    expect(result.assignments[0].scope).toBe(`/subscriptions/${SUB_B}`);
  });

  it("collapses an inherited assignment that repeats across every discovered subscription's listForScope call", async () => {
    // Azure's listForScope contract returns assignments inherited from parent
    // scopes (a management group, or root "/") on *every* descendant
    // subscription's query, not just once - confirmed live against a real
    // tenant, where a single root-scope assignment came back 18 times, once
    // per discovered subscription. Same fake assignment object (same .id) is
    // returned for both subscriptions here to reproduce that.
    mockDiscoveredSubscriptions([SUB_A, SUB_B]);
    const inheritedAssignment = {
      id: "/providers/Microsoft.Management/managementGroups/mg-1/providers/Microsoft.Authorization/roleAssignments/shared-guid",
      principalId: "group-1",
      principalType: "Group",
      roleDefinitionId: OWNER_GUID,
      scope: "/",
    };
    mockGetAuthorizationClientFn.mockImplementation(() => fakeClientWithAssignments([inheritedAssignment]));

    const result = await getAzureRoleAssignmentsCore("tenant-a", undefined, undefined);

    expect(result.assignments).toHaveLength(1);
  });

  it("throws when every discovered subscription is denied", async () => {
    mockDiscoveredSubscriptions([SUB_A]);
    const client = createFakeAuthorizationClient();
    client.roleAssignments.listForScope.mockImplementation(() => {
      throw new RestError("Forbidden", { statusCode: 403 });
    });
    mockGetAuthorizationClient(client);

    await expect(getAzureRoleAssignmentsCore("tenant-a", undefined, undefined)).rejects.toThrow(/denied every queried scope/);
  });

  it("throws a clear error when no subscriptions are visible at all", async () => {
    mockDiscoveredSubscriptions([]);

    await expect(getAzureRoleAssignmentsCore("tenant-a", undefined, undefined)).rejects.toThrow(/No Azure subscriptions are visible/);
  });
});

describe("registerGetAzureRoleAssignments -> get_azure_role_assignments", () => {
  it("happy path logs success and returns assignments", async () => {
    mockGetAuthorizationClient(
      fakeClientWithAssignments([{ principalId: "group-1", principalType: "Group", roleDefinitionId: OWNER_GUID, scope: `/subscriptions/${SUB_A}` }]),
    );

    const handler = captureToolHandler(registerGetAzureRoleAssignments, "get_azure_role_assignments");
    const result = await handler({ scope: `/subscriptions/${SUB_A}` });

    expect(result.isError).toBeUndefined();
    const payload = JSON.parse((result.content[0] as { text: string }).text);
    expect(payload.assignments).toHaveLength(1);
    expect(mockLogToolCall).toHaveBeenCalledWith(expect.objectContaining({ tool: "get_azure_role_assignments", status: "success" }));
  });

  it("rejects a malformed scope before any Azure call is made", async () => {
    const handler = captureToolHandler(registerGetAzureRoleAssignments, "get_azure_role_assignments");
    const result = await handler({ scope: "not-a-scope" });

    expect(result.isError).toBe(true);
  });
});
