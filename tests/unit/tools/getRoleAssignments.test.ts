import { resetEnvCacheForTests } from "../../../src/config/env";
import { queueGraphResponses } from "../../helpers/fakeGraphClient";
import { captureToolHandler } from "../../helpers/mcpTestServer";
import type { RoleDefinition } from "../../../src/cache/roleDefinitionsCache";

const SAMPLE_ROLE: RoleDefinition = {
  id: "11111111-1111-1111-1111-111111111111",
  displayName: "Global Administrator",
  isBuiltIn: true,
};

const SAMPLE_DIRECT_RESPONSE = {
  value: [
    {
      principalId: "user-1",
      principal: { id: "user-1", displayName: "Alice", "@odata.type": "#microsoft.graph.user" },
    },
  ],
};

// assignedPrincipals(transitive=true) returns a flat directoryObject list
// (not wrapped in a `principal` sub-object like roleAssignments is), and it
// always includes everything already in `direct` too - user-1 here is that
// duplicate, which getRoleAssignmentsCore is expected to filter back out.
const SAMPLE_TRANSITIVE_RESPONSE = {
  value: [
    { "@odata.type": "#microsoft.graph.user", id: "user-1", displayName: "Alice" },
    { "@odata.type": "#microsoft.graph.user", id: "user-2", displayName: "Bob" },
  ],
};

// Only resolveRoleDefinition is mocked (its own correctness is already
// unit-tested where roleLookup itself lives) - requireRoleIdentifier must
// stay real, or the "neither roleId nor roleName" test below would silently
// pass through to a mocked resolveRoleDefinition instead of failing
// validation.
jest.mock("../../../src/tools/shared/roleLookup", () => ({
  ...jest.requireActual("../../../src/tools/shared/roleLookup"),
  resolveRoleDefinition: jest.fn(),
}));

// Mocked so we can assert on exactly what gets audit-logged without a real
// console.error/JSON round trip.
jest.mock("../../../src/audit/logger", () => ({
  logToolCall: jest.fn(),
}));

jest.mock("../../../src/graph/client", () => ({
  getGraphClient: jest.fn(),
}));

import { resolveRoleDefinition } from "../../../src/tools/shared/roleLookup";
import { logToolCall } from "../../../src/audit/logger";
import { getGraphClient } from "../../../src/graph/client";
import { registerGetRoleAssignments, getRoleAssignmentsCore } from "../../../src/tools/getRoleAssignments";
import { clearServicePrincipalCacheForTests } from "../../../src/graph/servicePrincipalDirectory";

const mockResolveRoleDefinition = resolveRoleDefinition as jest.Mock;
const mockLogToolCall = logToolCall as jest.Mock;
const mockGetGraphClient = getGraphClient as jest.Mock;

const originalEnv = { ...process.env };

beforeEach(() => {
  resetEnvCacheForTests();
  clearServicePrincipalCacheForTests();
  process.env.AZURE_TENANT_ID = "11111111-1111-1111-1111-111111111111";
  process.env.AZURE_CLIENT_ID = "22222222-2222-2222-2222-222222222222";
  process.env.AZURE_CLIENT_SECRET = "fake-secret";

  mockResolveRoleDefinition.mockReset();
  mockLogToolCall.mockReset();
  mockGetGraphClient.mockReset();
  mockResolveRoleDefinition.mockResolvedValue(SAMPLE_ROLE);
});

afterEach(() => {
  process.env = { ...originalEnv };
  resetEnvCacheForTests();
});

describe("getRoleAssignmentsCore", () => {
  it("maps direct and transitive assignments and hits /beta with ConsistencyLevel: eventual for the transitive call", async () => {
    const { requests } = queueGraphResponses([{ data: SAMPLE_DIRECT_RESPONSE }, { data: SAMPLE_TRANSITIVE_RESPONSE }]);

    const result = await getRoleAssignmentsCore("tenant-a", SAMPLE_ROLE, true);

    expect(result.role).toEqual({ id: SAMPLE_ROLE.id, displayName: SAMPLE_ROLE.displayName });
    expect(result.direct).toEqual([{ principalId: "user-1", principalType: "user", principalDisplayName: "Alice" }]);
    expect(result.transitive).toEqual([{ principalId: "user-2", principalType: "user", principalDisplayName: "Bob" }]);

    expect(requests).toHaveLength(2);
    expect(requests[1].version).toBe("beta");
    expect(requests[1].headers["ConsistencyLevel"]).toBe("eventual");
  });

  it("resolves service-principal holders that arrive without a display name", async () => {
    const spDirectResponse = {
      value: [
        {
          principalId: "sp-1",
          principal: { id: "sp-1", "@odata.type": "#microsoft.graph.servicePrincipal" },
        },
      ],
    };
    const { requests } = queueGraphResponses([
      { data: spDirectResponse },
      { data: { id: "sp-1", displayName: "Backup Service", appId: "app-1" } },
    ]);

    const result = await getRoleAssignmentsCore("tenant-a", SAMPLE_ROLE, false);

    expect(result.direct).toEqual([{ principalId: "sp-1", principalType: "servicePrincipal", principalDisplayName: "Backup Service" }]);

    // direct assignments call + one service-principal lookup.
    expect(requests).toHaveLength(2);
    expect(requests[1].path).toBe("/servicePrincipals/sp-1");
  });

  it("leaves a service principal's name undefined when its lookup fails (no throw)", async () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      const spDirectResponse = {
        value: [{ principalId: "sp-x", principal: { id: "sp-x", "@odata.type": "#microsoft.graph.servicePrincipal" } }],
      };
      queueGraphResponses([{ data: spDirectResponse }, { error: new Error("404 Not Found") }]);

      const result = await getRoleAssignmentsCore("tenant-a", SAMPLE_ROLE, false);

      expect(result.direct).toEqual([{ principalId: "sp-x", principalType: "servicePrincipal", principalDisplayName: undefined }]);
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe("registerGetRoleAssignments -> get_role_assignments", () => {
  it("happy path: includeTransitive defaults to true and both arrays are populated", async () => {
    const { requests } = queueGraphResponses([{ data: SAMPLE_DIRECT_RESPONSE }, { data: SAMPLE_TRANSITIVE_RESPONSE }]);

    const handler = captureToolHandler(registerGetRoleAssignments, "get_role_assignments");
    const result = await handler({ roleId: SAMPLE_ROLE.id });

    expect(result.isError).toBeUndefined();
    const payload = JSON.parse((result.content[0] as { text: string }).text);
    expect(payload.direct).toEqual([{ principalId: "user-1", principalType: "user", principalDisplayName: "Alice" }]);
    expect(payload.transitive).toEqual([{ principalId: "user-2", principalType: "user", principalDisplayName: "Bob" }]);

    expect(requests).toHaveLength(2);
    expect(requests[1].version).toBe("beta");
    expect(requests[1].headers["ConsistencyLevel"]).toBe("eventual");

    expect(mockLogToolCall).toHaveBeenCalledWith(expect.objectContaining({ tool: "get_role_assignments", status: "success" }));
  });

  it("includeTransitive: false skips the transitive call entirely", async () => {
    const { requests } = queueGraphResponses([{ data: SAMPLE_DIRECT_RESPONSE }]);

    const handler = captureToolHandler(registerGetRoleAssignments, "get_role_assignments");
    const result = await handler({ roleId: SAMPLE_ROLE.id, includeTransitive: false });

    expect(result.isError).toBeUndefined();
    const payload = JSON.parse((result.content[0] as { text: string }).text);
    expect(payload.transitive).toBeUndefined();
    expect(requests).toHaveLength(1);
  });

  it("rejects a call with neither roleId nor roleName before any Graph call is made", async () => {
    const { requests } = queueGraphResponses([]);

    const handler = captureToolHandler(registerGetRoleAssignments, "get_role_assignments");
    const result = await handler({});

    expect(result.isError).toBe(true);
    expect(requests).toHaveLength(0);
    expect(mockResolveRoleDefinition).not.toHaveBeenCalled();

    expect(mockLogToolCall).toHaveBeenCalledWith(expect.objectContaining({ tool: "get_role_assignments", status: "validation_error" }));
  });

  it("explicit tenant GUID behaves identically to omitting the tenant field", async () => {
    queueGraphResponses([{ data: SAMPLE_DIRECT_RESPONSE }, { data: SAMPLE_TRANSITIVE_RESPONSE }]);
    const handler = captureToolHandler(registerGetRoleAssignments, "get_role_assignments");

    const result = await handler({ roleName: "Global Administrator", tenant: process.env.AZURE_TENANT_ID });

    expect(result.isError).toBeUndefined();
    expect(mockLogToolCall).toHaveBeenCalledWith(expect.objectContaining({ tool: "get_role_assignments", status: "success" }));
  });

  it("unknown tenant returns isError:true and validation_error with no Graph calls", async () => {
    const { requests } = queueGraphResponses([]);
    const handler = captureToolHandler(registerGetRoleAssignments, "get_role_assignments");

    const result = await handler({ roleName: "Global Administrator", tenant: "does-not-exist" });

    expect(result.isError).toBe(true);
    expect(requests).toHaveLength(0);
    expect(mockLogToolCall).toHaveBeenCalledWith(expect.objectContaining({ tool: "get_role_assignments", status: "validation_error" }));
  });
});
