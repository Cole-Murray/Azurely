import { resetEnvCacheForTests } from "../../../src/config/env";
import { clearAzureRoleDefinitionsCacheForTests } from "../../../src/cache/azureRoleDefinitionsCache";
import { queueGraphResponses } from "../../helpers/fakeGraphClient";
import { captureToolHandler } from "../../helpers/mcpTestServer";
import { createFakeAuthorizationClient, mockGetAuthorizationClient, mockDiscoveredSubscriptions, asyncIterableOf } from "../../helpers/fakeArmClient";
import type { DirectoryUser } from "../../../src/graph/userDirectory";

jest.mock("../../../src/graph/client", () => ({ getGraphClient: jest.fn() }));
jest.mock("../../../src/arm/client", () => ({
  getAuthorizationClient: jest.fn(),
  getSubscriptionClient: jest.fn(),
}));
jest.mock("../../../src/graph/userDirectory", () => ({
  ...jest.requireActual("../../../src/graph/userDirectory"),
  resolveUsers: jest.fn(),
}));
jest.mock("../../../src/audit/logger", () => ({ logToolCall: jest.fn() }));

import { logToolCall } from "../../../src/audit/logger";
import { resolveUsers } from "../../../src/graph/userDirectory";
import { getUserGroupPimEligibilityCore, registerGetUserGroupPimEligibility } from "../../../src/tools/getUserGroupPimEligibility";

const OWNER_GUID = "8e3af657-a8ff-443c-a75c-2fe8c4bcb635";
const SUB_A = "11111111-1111-1111-1111-111111111111";
const mockLogToolCall = logToolCall as jest.Mock;
const mockResolveUsers = resolveUsers as jest.Mock;

const ALICE: DirectoryUser = {
  id: "user-1",
  displayName: "Alice",
  userPrincipalName: "alice@contoso.example",
  mail: "alice@contoso.example",
  accountEnabled: true,
};

const originalEnv = { ...process.env };

beforeEach(() => {
  jest.clearAllMocks();
  clearAzureRoleDefinitionsCacheForTests();
  resetEnvCacheForTests();
  process.env.AZURE_TENANT_ID = SUB_A;
  process.env.AZURE_CLIENT_ID = "22222222-2222-2222-2222-222222222222";
  process.env.AZURE_CLIENT_SECRET = "fake-secret";
  mockResolveUsers.mockResolvedValue([ALICE]);
});

afterEach(() => {
  process.env = { ...originalEnv };
  resetEnvCacheForTests();
});

const GROUP_ELIGIBLE_INSTANCE = {
  id: "instance-1",
  principalId: "user-1",
  groupId: "group-1",
  accessId: "member",
  memberType: "direct",
  startDateTime: "2026-01-01T00:00:00Z",
  endDateTime: "2026-01-01T04:00:00Z",
  group: { id: "group-1", displayName: "SG-AZR-RG-Owner_RG-ClaudeAPI_PIM" },
};

describe("getUserGroupPimEligibilityCore", () => {
  it("maps an eligible group membership and cross-references the group's Azure RBAC role", async () => {
    queueGraphResponses([{ data: { value: [GROUP_ELIGIBLE_INSTANCE] } }, { data: { value: [] } }]);
    mockDiscoveredSubscriptions([SUB_A]);
    const armClient = createFakeAuthorizationClient();
    armClient.roleAssignments.listForScope.mockReturnValue(
      asyncIterableOf([{ principalId: "group-1", roleDefinitionId: OWNER_GUID, scope: `/subscriptions/${SUB_A}` }]),
    );
    armClient.roleDefinitions.list.mockReturnValue(asyncIterableOf([{ name: OWNER_GUID, roleName: "Owner" }]));
    mockGetAuthorizationClient(armClient);

    const result = await getUserGroupPimEligibilityCore("tenant-a", [ALICE]);

    expect(result.azureRoleLookupUnavailable).toBeUndefined();
    expect(result.groups).toEqual([
      {
        groupId: "group-1",
        groupDisplayName: "SG-AZR-RG-Owner_RG-ClaudeAPI_PIM",
        accessId: "member",
        assignmentType: "pim-eligible",
        startDateTime: "2026-01-01T00:00:00Z",
        endDateTime: "2026-01-01T04:00:00Z",
        account: "alice@contoso.example",
        azureRole: "Owner",
        azureScope: `/subscriptions/${SUB_A}`,
      },
    ]);
  });

  it("classifies an activated group assignment as pim-active and an assigned one as permanent", async () => {
    queueGraphResponses([
      { data: { value: [] } },
      {
        data: {
          value: [
            { ...GROUP_ELIGIBLE_INSTANCE, id: "a1", groupId: "group-a", assignmentType: "activated" },
            { ...GROUP_ELIGIBLE_INSTANCE, id: "a2", groupId: "group-b", assignmentType: "assigned" },
          ],
        },
      },
    ]);
    mockDiscoveredSubscriptions([]);

    const result = await getUserGroupPimEligibilityCore("tenant-a", [ALICE]);

    const activated = result.groups.find((g) => g.groupId === "group-a");
    const assigned = result.groups.find((g) => g.groupId === "group-b");
    expect(activated?.assignmentType).toBe("pim-active");
    expect(assigned?.assignmentType).toBe("permanent");
  });

  it("issues one roleAssignments.listForScope call per scope regardless of how many distinct groups are checked", async () => {
    queueGraphResponses([
      {
        data: {
          value: [
            { ...GROUP_ELIGIBLE_INSTANCE, id: "e1", groupId: "group-1", group: { id: "group-1", displayName: "Group One" } },
            { ...GROUP_ELIGIBLE_INSTANCE, id: "e2", groupId: "group-2", group: { id: "group-2", displayName: "Group Two" } },
          ],
        },
      },
      { data: { value: [] } },
    ]);
    mockDiscoveredSubscriptions([SUB_A]);
    const armClient = createFakeAuthorizationClient();
    armClient.roleAssignments.listForScope.mockReturnValue(
      asyncIterableOf([
        { principalId: "group-1", roleDefinitionId: OWNER_GUID, scope: `/subscriptions/${SUB_A}` },
        { principalId: "group-2", roleDefinitionId: OWNER_GUID, scope: `/subscriptions/${SUB_A}` },
        { principalId: "some-other-principal", roleDefinitionId: OWNER_GUID, scope: `/subscriptions/${SUB_A}` },
      ]),
    );
    armClient.roleDefinitions.list.mockReturnValue(asyncIterableOf([{ name: OWNER_GUID, roleName: "Owner" }]));
    mockGetAuthorizationClient(armClient);

    const result = await getUserGroupPimEligibilityCore("tenant-a", [ALICE]);

    expect(armClient.roleAssignments.listForScope).toHaveBeenCalledTimes(1);
    const group1 = result.groups.find((g) => g.groupId === "group-1");
    const group2 = result.groups.find((g) => g.groupId === "group-2");
    expect(group1?.azureRole).toBe("Owner");
    expect(group2?.azureRole).toBe("Owner");
  });

  it("degrades gracefully when the Azure RBAC cross-reference is unavailable, still returning the Graph-sourced eligibility data", async () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      queueGraphResponses([{ data: { value: [GROUP_ELIGIBLE_INSTANCE] } }, { data: { value: [] } }]);
      mockDiscoveredSubscriptions([]);

      const result = await getUserGroupPimEligibilityCore("tenant-a", [ALICE]);

      expect(result.azureRoleLookupUnavailable).toBe(true);
      expect(result.groups).toHaveLength(1);
      expect(result.groups[0].azureRole).toBeUndefined();
      expect(result.groups[0].groupDisplayName).toBe("SG-AZR-RG-Owner_RG-ClaudeAPI_PIM");
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe("registerGetUserGroupPimEligibility -> get_user_group_pim_eligibility", () => {
  it("happy path logs success", async () => {
    queueGraphResponses([{ data: { value: [] } }, { data: { value: [] } }]);
    mockDiscoveredSubscriptions([]);

    const handler = captureToolHandler(registerGetUserGroupPimEligibility, "get_user_group_pim_eligibility");
    const result = await handler({ userId: "alice" });

    expect(result.isError).toBeUndefined();
    expect(mockLogToolCall).toHaveBeenCalledWith(expect.objectContaining({ tool: "get_user_group_pim_eligibility", status: "success" }));
  });
});
