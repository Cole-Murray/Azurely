import { GraphError } from "@microsoft/microsoft-graph-client";
import { queueGraphResponses } from "../../helpers/fakeGraphClient";
import { captureToolHandler } from "../../helpers/mcpTestServer";
import { resetEnvCacheForTests } from "../../../src/config/env";
import { NotFoundError } from "../../../src/tools/shared/errors";

jest.mock("../../../src/graph/client");
jest.mock("../../../src/audit/logger");
jest.mock("../../../src/graph/userDirectory");

import { logToolCall } from "../../../src/audit/logger";
import { resolveUsers, type DirectoryUser } from "../../../src/graph/userDirectory";
import { registerGetUserDirectoryRoles } from "../../../src/tools/getUserDirectoryRoles";

const SAMPLE_USER: DirectoryUser = {
  id: "11111111-2222-3333-4444-555555555555",
  displayName: "Alex Example",
  userPrincipalName: "alex@contoso.example",
  mail: "alex@contoso.example",
  accountEnabled: true,
};

const SAMPLE_ADMIN_USER: DirectoryUser = {
  id: "66666666-7777-8888-9999-000000000000",
  displayName: "(Admin) Alex Example",
  userPrincipalName: "a-alex@contoso.example",
  mail: "alex+admin@contoso.example",
  accountEnabled: true,
};

const SAMPLE_ACTIVE_INSTANCE = {
  id: "active-1",
  principalId: SAMPLE_USER.id,
  roleDefinitionId: "role-active-1",
  roleDefinition: { id: "role-active-1", displayName: "User Administrator" },
  assignmentType: "Activated",
  startDateTime: "2026-01-01T00:00:00Z",
  endDateTime: "2026-06-01T00:00:00Z",
};

// A schedule instance Graph returns with assignmentType "Assigned" is a
// standing/permanent grant made outside PIM's time-boxing - not a temporary
// activation - even though it comes back from the same
// roleAssignmentScheduleInstances endpoint as a genuine PIM activation.
const SAMPLE_STANDING_ASSIGNED_INSTANCE = {
  id: "assigned-1",
  principalId: SAMPLE_USER.id,
  roleDefinitionId: "role-assigned-1",
  roleDefinition: { id: "role-assigned-1", displayName: "Security Reader" },
  assignmentType: "Assigned",
  startDateTime: "2024-09-28T00:56:06.227Z",
  endDateTime: undefined,
};

const SAMPLE_ELIGIBLE_INSTANCE = {
  id: "eligible-1",
  principalId: SAMPLE_USER.id,
  roleDefinitionId: "role-eligible-1",
  roleDefinition: { id: "role-eligible-1", displayName: "Global Administrator" },
  startDateTime: "2026-01-01T00:00:00Z",
};

const SAMPLE_PLAIN_ASSIGNMENT = {
  id: "assignment-1",
  principalId: SAMPLE_USER.id,
  roleDefinitionId: "role-plain-1",
  roleDefinition: { id: "role-plain-1", displayName: "Helpdesk Administrator" },
};

const SAMPLE_ADMIN_ELIGIBLE_INSTANCE = {
  id: "admin-eligible-1",
  principalId: SAMPLE_ADMIN_USER.id,
  roleDefinitionId: "role-global-admin",
  roleDefinition: { id: "role-global-admin", displayName: "Global Administrator" },
  startDateTime: "2025-07-17T23:44:50.39Z",
};

const originalEnv = { ...process.env };

beforeEach(() => {
  resetEnvCacheForTests();
  jest.clearAllMocks();
  process.env.AZURE_TENANT_ID = "11111111-1111-1111-1111-111111111111";
  process.env.AZURE_CLIENT_ID = "22222222-2222-2222-2222-222222222222";
  process.env.AZURE_CLIENT_SECRET = "fake-secret";
  (resolveUsers as jest.Mock).mockResolvedValue([SAMPLE_USER]);
});

afterEach(() => {
  process.env = { ...originalEnv };
  resetEnvCacheForTests();
});

describe("get_user_directory_roles", () => {
  it("returns merged active + eligible PIM roles on a P2-licensed tenant", async () => {
    queueGraphResponses([{ data: { value: [SAMPLE_ACTIVE_INSTANCE] } }, { data: { value: [SAMPLE_ELIGIBLE_INSTANCE] } }]);
    const handler = captureToolHandler(registerGetUserDirectoryRoles, "get_user_directory_roles");

    const result = await handler({ userId: "alex@contoso.example" });
    const payload = JSON.parse(result.content[0].text);

    expect(payload.roles).toHaveLength(2);
    expect(payload.roles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ roleDisplayName: "User Administrator", assignmentType: "pim-active" }),
        expect.objectContaining({ roleDisplayName: "Global Administrator", assignmentType: "pim-eligible" }),
      ]),
    );
    expect(payload.pimUnavailable).toBeUndefined();
  });

  it("classifies a standing (assignmentType: Assigned) schedule instance as permanent, not pim-active", async () => {
    queueGraphResponses([{ data: { value: [SAMPLE_STANDING_ASSIGNED_INSTANCE] } }, { data: { value: [] } }]);
    const handler = captureToolHandler(registerGetUserDirectoryRoles, "get_user_directory_roles");

    const result = await handler({ userId: "alex@contoso.example" });
    const payload = JSON.parse(result.content[0].text);

    expect(payload.roles).toHaveLength(1);
    expect(payload.roles[0]).toEqual(expect.objectContaining({ roleDisplayName: "Security Reader", assignmentType: "permanent" }));
  });

  it("falls back to plain role assignments when PIM is unavailable (non-P2 tenant)", async () => {
    // Promise.all issues both PIM calls before either resolves, so both
    // queue slots are consumed even though only the first (active) call's
    // rejection is what actually triggers the fallback; the third slot is
    // the fallback's own plain-assignments call.
    queueGraphResponses([
      { error: new GraphError(403, "Forbidden") },
      { data: { value: [] } },
      { data: { value: [SAMPLE_PLAIN_ASSIGNMENT] } },
    ]);
    const handler = captureToolHandler(registerGetUserDirectoryRoles, "get_user_directory_roles");

    const result = await handler({ userId: "alex@contoso.example" });
    const payload = JSON.parse(result.content[0].text);

    expect(payload.pimUnavailable).toBe(true);
    expect(payload.roles).toHaveLength(1);
    expect(payload.roles[0]).toEqual(
      expect.objectContaining({ roleDisplayName: "Helpdesk Administrator", assignmentType: "permanent" }),
    );
  });

  it("logs a success audit entry on the happy path", async () => {
    queueGraphResponses([{ data: { value: [SAMPLE_ACTIVE_INSTANCE] } }, { data: { value: [SAMPLE_ELIGIBLE_INSTANCE] } }]);
    const handler = captureToolHandler(registerGetUserDirectoryRoles, "get_user_directory_roles");

    await handler({ userId: "alex@contoso.example" });

    expect(logToolCall).toHaveBeenCalledWith(expect.objectContaining({ tool: "get_user_directory_roles", status: "success" }));
  });

  it("logs a success audit entry on the PIM-unavailable fallback (degraded, not an error)", async () => {
    queueGraphResponses([
      { error: new GraphError(403, "Forbidden") },
      { data: { value: [] } },
      { data: { value: [SAMPLE_PLAIN_ASSIGNMENT] } },
    ]);
    const handler = captureToolHandler(registerGetUserDirectoryRoles, "get_user_directory_roles");

    await handler({ userId: "alex@contoso.example" });

    expect(logToolCall).toHaveBeenCalledWith(expect.objectContaining({ tool: "get_user_directory_roles", status: "success" }));
  });

  it("reports a validation_error and isError:true when the user can't be resolved", async () => {
    (resolveUsers as jest.Mock).mockRejectedValue(new NotFoundError('No user found matching "nobody".'));
    const handler = captureToolHandler(registerGetUserDirectoryRoles, "get_user_directory_roles");

    const result = await handler({ userId: "nobody" });

    expect(result.isError).toBe(true);
    expect(logToolCall).toHaveBeenCalledWith(expect.objectContaining({ tool: "get_user_directory_roles", status: "validation_error" }));
  });

  it("explicit tenant GUID behaves identically to omitting the tenant field", async () => {
    queueGraphResponses([{ data: { value: [SAMPLE_ACTIVE_INSTANCE] } }, { data: { value: [SAMPLE_ELIGIBLE_INSTANCE] } }]);
    const handler = captureToolHandler(registerGetUserDirectoryRoles, "get_user_directory_roles");

    const result = await handler({ userId: "alex@contoso.example", tenant: process.env.AZURE_TENANT_ID });

    expect(result.isError).toBeUndefined();
    expect(logToolCall).toHaveBeenCalledWith(expect.objectContaining({ tool: "get_user_directory_roles", status: "success" }));
  });

  it("aggregates roles across every matched account when a name search resolves to more than one", async () => {
    (resolveUsers as jest.Mock).mockResolvedValue([SAMPLE_USER, SAMPLE_ADMIN_USER]);
    // Per-account fan-out: SAMPLE_USER's active+eligible calls, then SAMPLE_ADMIN_USER's.
    queueGraphResponses([
      { data: { value: [SAMPLE_STANDING_ASSIGNED_INSTANCE] } },
      { data: { value: [] } },
      { data: { value: [] } },
      { data: { value: [SAMPLE_ADMIN_ELIGIBLE_INSTANCE] } },
    ]);
    const handler = captureToolHandler(registerGetUserDirectoryRoles, "get_user_directory_roles");

    const result = await handler({ userId: "alex example" });
    const payload = JSON.parse(result.content[0].text);

    expect(payload.accountsMatched).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ userPrincipalName: "alex@contoso.example" }),
        expect.objectContaining({ userPrincipalName: "a-alex@contoso.example" }),
      ]),
    );
    expect(payload.roles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ roleDisplayName: "Security Reader", assignmentType: "permanent", account: "alex@contoso.example" }),
        expect.objectContaining({ roleDisplayName: "Global Administrator", assignmentType: "pim-eligible", account: "a-alex@contoso.example" }),
      ]),
    );
  });

  it("unknown tenant returns isError:true and validation_error with no Graph calls", async () => {
    const { requests } = queueGraphResponses([]);
    const handler = captureToolHandler(registerGetUserDirectoryRoles, "get_user_directory_roles");

    const result = await handler({ userId: "alex@contoso.example", tenant: "does-not-exist" });

    expect(result.isError).toBe(true);
    expect(requests).toHaveLength(0);
    expect(logToolCall).toHaveBeenCalledWith(expect.objectContaining({ tool: "get_user_directory_roles", status: "validation_error" }));
  });
});
