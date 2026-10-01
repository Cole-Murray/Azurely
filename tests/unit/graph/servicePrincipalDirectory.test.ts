jest.mock("../../../src/graph/client", () => ({
  getGraphClient: jest.fn(),
}));

import { queueGraphResponses } from "../../helpers/fakeGraphClient";
import { resolveServicePrincipalNames, clearServicePrincipalCacheForTests } from "../../../src/graph/servicePrincipalDirectory";

const TENANT = "tenant-a";

beforeEach(() => {
  clearServicePrincipalCacheForTests();
  jest.clearAllMocks();
});

describe("resolveServicePrincipalNames", () => {
  it("resolves ids to display names via one GET per id with a $select", async () => {
    const { requests } = queueGraphResponses([
      { data: { id: "sp-1", displayName: "Backup Service", appId: "app-1" } },
      { data: { id: "sp-2", displayName: "Provisioning Agent", appId: "app-2" } },
    ]);

    const names = await resolveServicePrincipalNames(TENANT, ["sp-1", "sp-2"]);

    expect(names.get("sp-1")).toBe("Backup Service");
    expect(names.get("sp-2")).toBe("Provisioning Agent");

    expect(requests).toHaveLength(2);
    expect(requests[0].path).toBe("/servicePrincipals/sp-1");
    expect(requests[0].selects).toEqual(["id", "displayName", "appId"]);
  });

  it("dedupes ids and serves cache hits without a second Graph call", async () => {
    const { requests } = queueGraphResponses([{ data: { id: "sp-1", displayName: "Backup Service" } }]);

    const first = await resolveServicePrincipalNames(TENANT, ["sp-1", "sp-1"]);
    expect(first.get("sp-1")).toBe("Backup Service");
    expect(requests).toHaveLength(1);

    // Second call for the same id must hit the cache - no new request queued.
    const second = await resolveServicePrincipalNames(TENANT, ["sp-1"]);
    expect(second.get("sp-1")).toBe("Backup Service");
    expect(requests).toHaveLength(1);
  });

  it("omits ids that fail to resolve instead of throwing, and does not cache the failure", async () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      queueGraphResponses([{ error: new Error("404 Not Found") }]);
      const names = await resolveServicePrincipalNames(TENANT, ["sp-missing"]);
      expect(names.has("sp-missing")).toBe(false);

      // A negative result is not cached, so a later successful call retries.
      const { requests } = queueGraphResponses([{ data: { id: "sp-missing", displayName: "Recovered Later" } }]);
      const retry = await resolveServicePrincipalNames(TENANT, ["sp-missing"]);
      expect(retry.get("sp-missing")).toBe("Recovered Later");
      expect(requests).toHaveLength(1);
    } finally {
      errorSpy.mockRestore();
    }
  });
});
