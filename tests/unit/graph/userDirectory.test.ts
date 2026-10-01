import { queueGraphResponses } from "../../helpers/fakeGraphClient";

jest.mock("../../../src/graph/client");

import { resolveUsers, searchUsersCore, resolveUserDisplayNames, clearUserNameCacheForTests } from "../../../src/graph/userDirectory";
import { AmbiguousMatchError, NotFoundError } from "../../../src/tools/shared/errors";

beforeEach(() => {
  clearUserNameCacheForTests();
});

// Graph's /users $filter only supports startswith() - it flatly rejects
// contains() (Request_UnsupportedQuery) - so a person whose display name
// doesn't start with the search text (e.g. a privileged "(Admin) Jordan
// Lee" account distinct from "Jordan Lee") is invisible to a
// startswith-based search. $search does token-based matching instead and
// finds both. Verified live against Graph Explorer before writing this.
describe("searchUsersCore", () => {
  it("issues a $search query instead of a startswith $filter", async () => {
    const { requests } = queueGraphResponses([{ data: { value: [] } }]);

    await searchUsersCore("tenant-1", "jordan lee", 25);

    expect(requests[0].filters).toHaveLength(0);
    expect(requests[0].search).toContain("jordan lee");
    expect(requests[0].search).not.toMatch(/startswith/);
  });

  it("searches across displayName, userPrincipalName, and mail", async () => {
    const { requests } = queueGraphResponses([{ data: { value: [] } }]);

    await searchUsersCore("tenant-1", "jordan lee", 25);

    expect(requests[0].search).toContain("displayName:jordan lee");
    expect(requests[0].search).toContain("userPrincipalName:jordan lee");
    expect(requests[0].search).toContain("mail:jordan lee");
  });
});

const JORDAN_PERSONAL = {
  id: "1",
  displayName: "Jordan Lee",
  userPrincipalName: "jlee@contoso.example",
  mail: "jlee@contoso.example",
  accountEnabled: true,
};
const JORDAN_ADMIN = {
  id: "2",
  displayName: "(Admin) Jordan Lee",
  userPrincipalName: "a-jlee@contoso.onmicrosoft.com",
  mail: "jlee+admin@contoso.example",
  accountEnabled: true,
};

describe("resolveUsers", () => {
  it("returns every matched account for a free-text query instead of erroring on more than one", async () => {
    // A name search can legitimately hit multiple accounts belonging to the
    // same person - e.g. a standing account and a separate privileged
    // "(Admin) Name" account - and get_user_directory_roles wants the full
    // picture across all of them rather than forcing a caller to guess which
    // one to check first.
    queueGraphResponses([{ data: { value: [JORDAN_PERSONAL, JORDAN_ADMIN] } }]);

    const matches = await resolveUsers("tenant-1", "jordan lee");

    expect(matches).toHaveLength(2);
    expect(matches).toEqual(expect.arrayContaining([JORDAN_PERSONAL, JORDAN_ADMIN]));
  });

  it("returns exactly one account when only one matches", async () => {
    queueGraphResponses([{ data: { value: [JORDAN_PERSONAL] } }]);

    const matches = await resolveUsers("tenant-1", "jordan lee");

    expect(matches).toEqual([JORDAN_PERSONAL]);
  });

  it("throws NotFoundError when nothing matches", async () => {
    queueGraphResponses([{ data: { value: [] } }]);

    await expect(resolveUsers("tenant-1", "nobody")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("throws AmbiguousMatchError when a query is too broad to aggregate (over the cap)", async () => {
    const tooMany = Array.from({ length: 6 }, (_, i) => ({
      id: `user-${i}`,
      displayName: `Alex ${i}`,
      userPrincipalName: `alex${i}@contoso.example`,
      mail: `alex${i}@contoso.example`,
      accountEnabled: true,
    }));
    queueGraphResponses([{ data: { value: tooMany } }]);

    await expect(resolveUsers("tenant-1", "alex")).rejects.toBeInstanceOf(AmbiguousMatchError);
  });
});

// Needed by the Azure RBAC tools: unlike get_role_assignments' $expand=principal
// on the directory plane, ARM's roleAssignments/PIM objects return only a
// principalId GUID for every principal type - there's no ARM-side expand
// that populates a display name, so this batched resolver mirrors
// resolveServicePrincipalNames' cache-and-degrade contract exactly.
describe("resolveUserDisplayNames", () => {
  it("resolves ids to display names via one GET per id with a $select", async () => {
    const { requests } = queueGraphResponses([{ data: { id: "user-1", displayName: "Alice" } }, { data: { id: "user-2", displayName: "Bob" } }]);

    const names = await resolveUserDisplayNames("tenant-1", ["user-1", "user-2"]);

    expect(names.get("user-1")).toBe("Alice");
    expect(names.get("user-2")).toBe("Bob");
    expect(requests).toHaveLength(2);
    expect(requests[0].path).toBe("/users/user-1");
    expect(requests[0].selects).toEqual(["id", "displayName"]);
  });

  it("dedupes ids and serves cache hits without a second Graph call", async () => {
    const { requests } = queueGraphResponses([{ data: { id: "user-1", displayName: "Alice" } }]);

    const first = await resolveUserDisplayNames("tenant-1", ["user-1", "user-1"]);
    expect(first.get("user-1")).toBe("Alice");
    expect(requests).toHaveLength(1);

    const second = await resolveUserDisplayNames("tenant-1", ["user-1"]);
    expect(second.get("user-1")).toBe("Alice");
    expect(requests).toHaveLength(1);
  });

  it("omits ids that fail to resolve instead of throwing, and does not cache the failure", async () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      queueGraphResponses([{ error: new Error("404 Not Found") }]);
      const names = await resolveUserDisplayNames("tenant-1", ["user-missing"]);
      expect(names.has("user-missing")).toBe(false);

      const { requests } = queueGraphResponses([{ data: { id: "user-missing", displayName: "Recovered Later" } }]);
      const retry = await resolveUserDisplayNames("tenant-1", ["user-missing"]);
      expect(retry.get("user-missing")).toBe("Recovered Later");
      expect(requests).toHaveLength(1);
    } finally {
      errorSpy.mockRestore();
    }
  });
});
