jest.mock("../../../src/graph/servicePrincipalDirectory", () => ({
  resolveServicePrincipalNames: jest.fn(),
}));
jest.mock("../../../src/graph/userDirectory", () => ({
  resolveUserDisplayNames: jest.fn(),
}));

import { resolveServicePrincipalNames } from "../../../src/graph/servicePrincipalDirectory";
import { resolveUserDisplayNames } from "../../../src/graph/userDirectory";
import { enrichArmPrincipalNames, type ArmPrincipalHolder } from "../../../src/arm/principalEnrichment";

const mockResolveServicePrincipalNames = resolveServicePrincipalNames as jest.Mock;
const mockResolveUserDisplayNames = resolveUserDisplayNames as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  mockResolveServicePrincipalNames.mockResolvedValue(new Map());
  mockResolveUserDisplayNames.mockResolvedValue(new Map());
});

describe("enrichArmPrincipalNames", () => {
  it("resolves User holders via resolveUserDisplayNames and ServicePrincipal holders via resolveServicePrincipalNames", async () => {
    mockResolveUserDisplayNames.mockResolvedValue(new Map([["user-1", "Alice"]]));
    mockResolveServicePrincipalNames.mockResolvedValue(new Map([["sp-1", "Backup Service"]]));

    const holders: ArmPrincipalHolder[] = [
      { principalId: "user-1", principalType: "User" },
      { principalId: "sp-1", principalType: "ServicePrincipal" },
    ];

    await enrichArmPrincipalNames("tenant-a", [holders]);

    expect(holders[0].principalDisplayName).toBe("Alice");
    expect(holders[1].principalDisplayName).toBe("Backup Service");
    expect(mockResolveUserDisplayNames).toHaveBeenCalledWith("tenant-a", ["user-1"]);
    expect(mockResolveServicePrincipalNames).toHaveBeenCalledWith("tenant-a", ["sp-1"]);
  });

  it("leaves Group holders unresolved by design", async () => {
    const holders: ArmPrincipalHolder[] = [{ principalId: "group-1", principalType: "Group" }];

    await enrichArmPrincipalNames("tenant-a", [holders]);

    expect(holders[0].principalDisplayName).toBeUndefined();
    expect(mockResolveUserDisplayNames).not.toHaveBeenCalled();
    expect(mockResolveServicePrincipalNames).not.toHaveBeenCalled();
  });

  it("skips holders that already have a display name", async () => {
    const holders: ArmPrincipalHolder[] = [{ principalId: "user-1", principalType: "User", principalDisplayName: "Already Known" }];

    await enrichArmPrincipalNames("tenant-a", [holders]);

    expect(mockResolveUserDisplayNames).not.toHaveBeenCalled();
    expect(holders[0].principalDisplayName).toBe("Already Known");
  });

  it("merges holders across multiple lists into one batched lookup", async () => {
    mockResolveUserDisplayNames.mockResolvedValue(new Map([["user-1", "Alice"]]));

    const listA: ArmPrincipalHolder[] = [{ principalId: "user-1", principalType: "User" }];
    const listB: ArmPrincipalHolder[] = [{ principalId: "user-1", principalType: "User" }];

    await enrichArmPrincipalNames("tenant-a", [listA, listB]);

    expect(mockResolveUserDisplayNames).toHaveBeenCalledTimes(1);
    expect(listA[0].principalDisplayName).toBe("Alice");
    expect(listB[0].principalDisplayName).toBe("Alice");
  });
});
