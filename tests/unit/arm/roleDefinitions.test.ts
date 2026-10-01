jest.mock("../../../src/arm/client", () => ({
  getAuthorizationClient: jest.fn(),
}));

import { createFakeAuthorizationClient, mockGetAuthorizationClient, asyncIterableOf } from "../../helpers/fakeArmClient";
import { clearAzureRoleDefinitionsCacheForTests } from "../../../src/cache/azureRoleDefinitionsCache";
import { extractRoleDefinitionGuid, listAzureRoleDefinitions, resolveAzureRoleName } from "../../../src/arm/roleDefinitions";

const OWNER_GUID = "8e3af657-a8ff-443c-a75c-2fe8c4bcb635";
const SUB_ID = "11111111-1111-1111-1111-111111111111";

beforeEach(() => {
  jest.clearAllMocks();
  clearAzureRoleDefinitionsCacheForTests();
});

describe("extractRoleDefinitionGuid", () => {
  it("extracts the trailing GUID from a full role definition resource path", () => {
    expect(extractRoleDefinitionGuid(`/subscriptions/${SUB_ID}/providers/Microsoft.Authorization/roleDefinitions/${OWNER_GUID}`)).toBe(OWNER_GUID);
  });

  it("returns a bare GUID unchanged", () => {
    expect(extractRoleDefinitionGuid(OWNER_GUID)).toBe(OWNER_GUID);
  });
});

describe("listAzureRoleDefinitions", () => {
  it("lists and caches role definitions per subscription", async () => {
    const client = createFakeAuthorizationClient();
    client.roleDefinitions.list.mockReturnValue(asyncIterableOf([{ name: OWNER_GUID, roleName: "Owner" }]));
    mockGetAuthorizationClient(client);

    const first = await listAzureRoleDefinitions("tenant-a", SUB_ID);
    expect(first).toEqual([{ id: OWNER_GUID, roleName: "Owner" }]);

    // Second call for the same tenant+subscription must be served from
    // cache - roleDefinitions.list is not called again.
    await listAzureRoleDefinitions("tenant-a", SUB_ID);
    expect(client.roleDefinitions.list).toHaveBeenCalledTimes(1);
  });

  it("skips a definition missing name or roleName rather than throwing", async () => {
    const client = createFakeAuthorizationClient();
    client.roleDefinitions.list.mockReturnValue(asyncIterableOf([{ name: OWNER_GUID, roleName: "Owner" }, { name: undefined, roleName: "Broken" }]));
    mockGetAuthorizationClient(client);

    const definitions = await listAzureRoleDefinitions("tenant-a", SUB_ID);
    expect(definitions).toEqual([{ id: OWNER_GUID, roleName: "Owner" }]);
  });
});

describe("resolveAzureRoleName", () => {
  it("resolves a full roleDefinitionId path to its display name", async () => {
    const client = createFakeAuthorizationClient();
    client.roleDefinitions.list.mockReturnValue(asyncIterableOf([{ name: OWNER_GUID, roleName: "Owner" }]));
    mockGetAuthorizationClient(client);

    const name = await resolveAzureRoleName("tenant-a", SUB_ID, `/subscriptions/${SUB_ID}/providers/Microsoft.Authorization/roleDefinitions/${OWNER_GUID}`);
    expect(name).toBe("Owner");
  });

  it("falls back to the raw GUID when the definition isn't in the cached list", async () => {
    const client = createFakeAuthorizationClient();
    client.roleDefinitions.list.mockReturnValue(asyncIterableOf([]));
    mockGetAuthorizationClient(client);

    const name = await resolveAzureRoleName("tenant-a", SUB_ID, OWNER_GUID);
    expect(name).toBe(OWNER_GUID);
  });
});
