import { clearRoleDefinitionsCacheForTests, getRoleDefinitions, type RoleDefinition } from "../../../src/cache/roleDefinitionsCache";

const SAMPLE_ROLES: RoleDefinition[] = [{ id: "role-1", displayName: "Global Administrator", isBuiltIn: true }];

beforeEach(() => {
  clearRoleDefinitionsCacheForTests();
});

describe("getRoleDefinitions", () => {
  it("calls the fetcher on a cache miss", async () => {
    const fetcher = jest.fn().mockResolvedValue(SAMPLE_ROLES);

    const result = await getRoleDefinitions("tenant-a", fetcher);

    expect(result).toEqual(SAMPLE_ROLES);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not call the fetcher again on a cache hit", async () => {
    const fetcher = jest.fn().mockResolvedValue(SAMPLE_ROLES);

    await getRoleDefinitions("tenant-a", fetcher);
    await getRoleDefinitions("tenant-a", fetcher);

    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("caches independently per tenant", async () => {
    const fetcherA = jest.fn().mockResolvedValue(SAMPLE_ROLES);
    const fetcherB = jest.fn().mockResolvedValue([{ id: "role-2", displayName: "User Administrator", isBuiltIn: true }]);

    await getRoleDefinitions("tenant-a", fetcherA);
    await getRoleDefinitions("tenant-b", fetcherB);

    expect(fetcherA).toHaveBeenCalledTimes(1);
    expect(fetcherB).toHaveBeenCalledTimes(1);
  });
});
