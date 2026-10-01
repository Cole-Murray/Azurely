import { queueGraphResponses } from "../../helpers/fakeGraphClient";
import { captureToolHandler } from "../../helpers/mcpTestServer";
import { resetEnvCacheForTests } from "../../../src/config/env";
import { HIGH_RISK_ROLES } from "../../../src/domain/highRiskRoles";

jest.mock("../../../src/graph/client");
jest.mock("../../../src/audit/logger");
// Only resolveRoleDefinition is mocked (its own correctness is covered by
// roleLookup's own tests) - requireRoleIdentifier must stay real, or the
// "neither roleId nor roleName" test below would silently pass through to
// a mocked resolveRoleDefinition instead of failing validation.
jest.mock("../../../src/tools/shared/roleLookup", () => ({
  ...jest.requireActual("../../../src/tools/shared/roleLookup"),
  resolveRoleDefinition: jest.fn(),
}));

import { logToolCall } from "../../../src/audit/logger";
import { resolveRoleDefinition } from "../../../src/tools/shared/roleLookup";
import { registerExplainDirectoryRole } from "../../../src/tools/explainDirectoryRole";

// A known key in HIGH_RISK_ROLES (see src/domain/highRiskRoles.ts) - Global
// Administrator's fixed built-in role template ID, same across every tenant.
const GLOBAL_ADMIN_ID = "62e90394-69f5-4237-9190-012177145e10";
// Not a key in HIGH_RISK_ROLES - exercises the fallback-to-Graph path.
const UNCATALOGED_ROLE_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

const originalEnv = { ...process.env };

beforeEach(() => {
  resetEnvCacheForTests();
  jest.clearAllMocks();
  process.env.AZURE_TENANT_ID = "11111111-1111-1111-1111-111111111111";
  process.env.AZURE_CLIENT_ID = "22222222-2222-2222-2222-222222222222";
  process.env.AZURE_CLIENT_SECRET = "fake-secret";
});

afterEach(() => {
  process.env = { ...originalEnv };
  resetEnvCacheForTests();
});

describe("explain_directory_role", () => {
  it("returns the curated risk tier and summary without calling Graph", async () => {
    (resolveRoleDefinition as jest.Mock).mockResolvedValue({
      id: GLOBAL_ADMIN_ID,
      displayName: "Global Administrator",
      description: "Can manage all aspects of Entra ID and Microsoft 365.",
      isBuiltIn: true,
    });
    // Nothing queued - if the tool tried to call Graph on this path, the
    // fake client would throw "no queued response" and fail the test.
    const fake = queueGraphResponses([]);
    const handler = captureToolHandler(registerExplainDirectoryRole, "explain_directory_role");

    const result = await handler({ roleId: GLOBAL_ADMIN_ID });
    const payload = JSON.parse(result.content[0].text);

    expect(payload.role).toEqual({
      id: GLOBAL_ADMIN_ID,
      displayName: "Global Administrator",
      description: "Can manage all aspects of Entra ID and Microsoft 365.",
      isBuiltIn: true,
    });
    expect(payload.riskTier).toBe(HIGH_RISK_ROLES[GLOBAL_ADMIN_ID].riskTier);
    expect(payload.summary).toBe(HIGH_RISK_ROLES[GLOBAL_ADMIN_ID].summary);
    expect(payload.rawPermissionActions).toBeUndefined();
    expect(fake.requests).toHaveLength(0);
    expect(logToolCall).toHaveBeenCalledWith(expect.objectContaining({ tool: "explain_directory_role", status: "success" }));
  });

  it("falls back to raw Graph permissions for a role not in the curated catalog", async () => {
    (resolveRoleDefinition as jest.Mock).mockResolvedValue({
      id: UNCATALOGED_ROLE_ID,
      displayName: "Custom Reports Reader",
      description: "Reads usage reports.",
      isBuiltIn: false,
    });
    const fake = queueGraphResponses([
      {
        data: {
          id: UNCATALOGED_ROLE_ID,
          displayName: "Custom Reports Reader",
          description: "Reads usage reports.",
          isBuiltIn: false,
          rolePermissions: [{ allowedResourceActions: ["microsoft.directory/reports/read"] }],
        },
      },
    ]);
    const handler = captureToolHandler(registerExplainDirectoryRole, "explain_directory_role");

    const result = await handler({ roleId: UNCATALOGED_ROLE_ID });
    const payload = JSON.parse(result.content[0].text);

    expect(payload.riskTier).toBeUndefined();
    expect(payload.rawPermissionActions).toEqual(["microsoft.directory/reports/read"]);
    expect(payload.summary).toBe("No curated summary available for this role - showing raw permitted actions instead.");
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0].path).toBe(`/roleManagement/directory/roleDefinitions/${UNCATALOGED_ROLE_ID}`);
    expect(logToolCall).toHaveBeenCalledWith(expect.objectContaining({ tool: "explain_directory_role", status: "success" }));
  });

  it("rejects a call with neither roleId nor roleName as a validation error with zero Graph calls", async () => {
    const fake = queueGraphResponses([]);
    const handler = captureToolHandler(registerExplainDirectoryRole, "explain_directory_role");

    const result = await handler({});

    expect(result.isError).toBe(true);
    expect(logToolCall).toHaveBeenCalledWith(
      expect.objectContaining({ tool: "explain_directory_role", status: "validation_error" }),
    );
    expect(fake.requests).toHaveLength(0);
    expect(resolveRoleDefinition).not.toHaveBeenCalled();
  });

  it("explicit tenant GUID behaves identically to omitting the tenant field", async () => {
    (resolveRoleDefinition as jest.Mock).mockResolvedValue({
      id: GLOBAL_ADMIN_ID,
      displayName: "Global Administrator",
      description: "Can manage all aspects of Entra ID and Microsoft 365.",
      isBuiltIn: true,
    });
    queueGraphResponses([]);
    const handler = captureToolHandler(registerExplainDirectoryRole, "explain_directory_role");

    const result = await handler({ roleId: GLOBAL_ADMIN_ID, tenant: process.env.AZURE_TENANT_ID });

    expect(result.isError).toBeUndefined();
    expect(logToolCall).toHaveBeenCalledWith(expect.objectContaining({ tool: "explain_directory_role", status: "success" }));
  });

  it("unknown tenant returns isError:true and validation_error with no Graph calls", async () => {
    const { requests } = queueGraphResponses([]);
    const handler = captureToolHandler(registerExplainDirectoryRole, "explain_directory_role");

    const result = await handler({ roleId: GLOBAL_ADMIN_ID, tenant: "does-not-exist" });

    expect(result.isError).toBe(true);
    expect(requests).toHaveLength(0);
    expect(logToolCall).toHaveBeenCalledWith(expect.objectContaining({ tool: "explain_directory_role", status: "validation_error" }));
  });
});
