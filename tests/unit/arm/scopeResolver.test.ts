import { RestError } from "@azure/core-rest-pipeline";

jest.mock("../../../src/arm/client", () => ({
  getSubscriptionClient: jest.fn(),
}));

import { mockDiscoveredSubscriptions } from "../../helpers/fakeArmClient";
import { ToolInputError } from "../../../src/tools/shared/errors";
import {
  parseExplicitScope,
  discoverSubscriptionScopes,
  resolveAzureScopes,
  assertScopesDiscovered,
  assertNotAllScopesDenied,
  queryEachScope,
  type AzureScope,
} from "../../../src/arm/scopeResolver";

const SUB_ID = "11111111-1111-1111-1111-111111111111";

beforeEach(() => {
  jest.clearAllMocks();
});

describe("parseExplicitScope", () => {
  it("parses a bare subscription scope", () => {
    expect(parseExplicitScope(`/subscriptions/${SUB_ID}`)).toEqual({ path: `/subscriptions/${SUB_ID}`, subscriptionId: SUB_ID });
  });

  it("parses a subscription + resource group scope", () => {
    const scope = `/subscriptions/${SUB_ID}/resourceGroups/RG-ClaudeAPI`;
    expect(parseExplicitScope(scope)).toEqual({ path: scope, subscriptionId: SUB_ID });
  });

  it("throws ToolInputError for a malformed scope", () => {
    expect(() => parseExplicitScope("not-a-scope")).toThrow(ToolInputError);
  });
});

describe("discoverSubscriptionScopes / resolveAzureScopes", () => {
  it("enumerates every visible subscription into a scope", async () => {
    mockDiscoveredSubscriptions([SUB_ID, "22222222-2222-2222-2222-222222222222"]);

    const scopes = await discoverSubscriptionScopes("tenant-a");

    expect(scopes).toEqual([
      { path: `/subscriptions/${SUB_ID}`, subscriptionId: SUB_ID },
      { path: "/subscriptions/22222222-2222-2222-2222-222222222222", subscriptionId: "22222222-2222-2222-2222-222222222222" },
    ]);
  });

  it("resolveAzureScopes with an explicit scope skips discovery entirely", async () => {
    mockDiscoveredSubscriptions([SUB_ID]);

    const scopes = await resolveAzureScopes("tenant-a", `/subscriptions/${SUB_ID}/resourceGroups/RG-1`);

    expect(scopes).toEqual([{ path: `/subscriptions/${SUB_ID}/resourceGroups/RG-1`, subscriptionId: SUB_ID }]);
  });

  it("resolveAzureScopes with no explicit scope falls back to discovery", async () => {
    mockDiscoveredSubscriptions([SUB_ID]);

    const scopes = await resolveAzureScopes("tenant-a", undefined);

    expect(scopes).toEqual([{ path: `/subscriptions/${SUB_ID}`, subscriptionId: SUB_ID }]);
  });
});

describe("assertScopesDiscovered", () => {
  it("throws when nothing was discovered", () => {
    expect(() => assertScopesDiscovered([])).toThrow(/No Azure subscriptions are visible/);
  });

  it("does not throw when at least one scope exists", () => {
    expect(() => assertScopesDiscovered([{ path: "/subscriptions/x", subscriptionId: "x" }])).not.toThrow();
  });
});

describe("assertNotAllScopesDenied", () => {
  const scopes: AzureScope[] = [
    { path: "/subscriptions/a", subscriptionId: "a" },
    { path: "/subscriptions/b", subscriptionId: "b" },
  ];

  it("throws when every scope was denied", () => {
    expect(() => assertNotAllScopesDenied(scopes, ["/subscriptions/a", "/subscriptions/b"])).toThrow(/denied every queried scope/);
  });

  it("does not throw when only some scopes were denied", () => {
    expect(() => assertNotAllScopesDenied(scopes, ["/subscriptions/a"])).not.toThrow();
  });

  it("does not throw when nothing was denied", () => {
    expect(() => assertNotAllScopesDenied(scopes, [])).not.toThrow();
  });
});

describe("queryEachScope", () => {
  const scopes: AzureScope[] = [
    { path: "/subscriptions/a", subscriptionId: "a" },
    { path: "/subscriptions/b", subscriptionId: "b" },
  ];

  it("returns items per scope when every scope succeeds", async () => {
    const { perScope, deniedScopes } = await queryEachScope(scopes, async (scope) => [`item-from-${scope.subscriptionId}`]);

    expect(deniedScopes).toEqual([]);
    expect(perScope.map((entry) => entry.items)).toEqual([["item-from-a"], ["item-from-b"]]);
  });

  it("degrades a 403'd scope to an empty item list and records it as denied, without affecting other scopes", async () => {
    const { perScope, deniedScopes } = await queryEachScope(scopes, async (scope) => {
      if (scope.subscriptionId === "a") {
        throw new RestError("Forbidden", { statusCode: 403 });
      }
      return ["item-from-b"];
    });

    expect(deniedScopes).toEqual(["/subscriptions/a"]);
    expect(perScope.find((entry) => entry.scope.subscriptionId === "a")?.items).toEqual([]);
    expect(perScope.find((entry) => entry.scope.subscriptionId === "b")?.items).toEqual(["item-from-b"]);
  });

  it("rethrows a non-403 failure instead of degrading it", async () => {
    await expect(
      queryEachScope(scopes, async () => {
        throw new RestError("Internal Server Error", { statusCode: 500 });
      }),
    ).rejects.toMatchObject({ statusCode: 500 });
  });

  it("degrades a 400/InsufficientPermissions scope the same as a 403 - Azure's PIM schedule-instance endpoints reject an unfiltered query this way instead of with a 403", async () => {
    const { perScope, deniedScopes } = await queryEachScope(scopes, async (scope) => {
      if (scope.subscriptionId === "a") {
        throw new RestError("Bad Request", { statusCode: 400, code: "InsufficientPermissions" });
      }
      return ["item-from-b"];
    });

    expect(deniedScopes).toEqual(["/subscriptions/a"]);
    expect(perScope.find((entry) => entry.scope.subscriptionId === "a")?.items).toEqual([]);
    expect(perScope.find((entry) => entry.scope.subscriptionId === "b")?.items).toEqual(["item-from-b"]);
  });

  it("rethrows a 400 with an unrelated code instead of degrading it", async () => {
    await expect(
      queryEachScope(scopes, async () => {
        throw new RestError("Bad Request", { statusCode: 400, code: "InvalidParameter" });
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: "InvalidParameter" });
  });
});
