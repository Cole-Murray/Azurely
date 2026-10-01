import { GraphError } from "@microsoft/microsoft-graph-client";
import { logToolCall } from "../../../src/audit/logger";
import { resetEnvCacheForTests } from "../../../src/config/env";
import { registerGetRecentRoleChanges } from "../../../src/tools/getRecentRoleChanges";
import { queueGraphResponses } from "../../helpers/fakeGraphClient";
import { captureToolHandler } from "../../helpers/mcpTestServer";

jest.mock("../../../src/graph/client");
jest.mock("../../../src/audit/logger");

const originalEnv = { ...process.env };

const SAMPLE_ENTRIES = [
  {
    activityDateTime: "2026-07-01T12:00:00Z",
    activityDisplayName: "Add member to role",
    initiatedBy: { user: { userPrincipalName: "admin@contoso.example" } },
    targetResources: [{ displayName: "Alex Rivera", type: "User" }],
    result: "success",
  },
  {
    activityDateTime: "2026-06-30T09:00:00Z",
    activityDisplayName: "Remove member from role",
    initiatedBy: { app: { displayName: "Access Reviews" } },
    targetResources: [{ displayName: "Alexis Chen", type: "User" }],
    result: "failure",
  },
  {
    activityDateTime: "2026-06-29T09:00:00Z",
    activityDisplayName: "Add eligible member to role",
    initiatedBy: { user: { userPrincipalName: "other.admin@contoso.example" } },
    targetResources: [{ displayName: "Jamie Lee", type: "User" }],
    result: "success",
  },
];

beforeEach(() => {
  resetEnvCacheForTests();
  process.env.AZURE_TENANT_ID = "11111111-1111-1111-1111-111111111111";
  process.env.AZURE_CLIENT_ID = "22222222-2222-2222-2222-222222222222";
  process.env.AZURE_CLIENT_SECRET = "fake-secret";
  jest.clearAllMocks();
});

afterEach(() => {
  process.env = { ...originalEnv };
  resetEnvCacheForTests();
});

describe("get_recent_role_changes tool", () => {
  it("maps raw audit entries into RoleChangeEntry shapes and returns a valid since date", async () => {
    queueGraphResponses([{ data: { value: SAMPLE_ENTRIES } }]);

    const handler = captureToolHandler(registerGetRecentRoleChanges, "get_recent_role_changes");
    const result = await handler({ days: 14 });

    const parsed = JSON.parse(result.content[0].text);
    expect(result.isError).toBeUndefined();
    expect(parsed.changes).toHaveLength(3);

    expect(parsed.changes[0]).toEqual({
      activityDateTime: "2026-07-01T12:00:00Z",
      activityDisplayName: "Add member to role",
      initiatedBy: "admin@contoso.example",
      targetResources: [{ displayName: "Alex Rivera", type: "User" }],
      result: "success",
    });
    expect(parsed.changes[1]).toEqual({
      activityDateTime: "2026-06-30T09:00:00Z",
      activityDisplayName: "Remove member from role",
      initiatedBy: "Access Reviews",
      targetResources: [{ displayName: "Alexis Chen", type: "User" }],
      result: "failure",
    });

    const since = new Date(parsed.since);
    expect(Number.isNaN(since.getTime())).toBe(false);
    const expectedSince = Date.now() - 14 * 86400000;
    expect(Math.abs(since.getTime() - expectedSince)).toBeLessThan(5000);

    expect(logToolCall).toHaveBeenCalledWith(expect.objectContaining({ tool: "get_recent_role_changes", status: "success" }));
  });

  it("issues the Graph request with ConsistencyLevel: eventual and a RoleManagement category filter", async () => {
    const { requests } = queueGraphResponses([{ data: { value: SAMPLE_ENTRIES } }]);

    const handler = captureToolHandler(registerGetRecentRoleChanges, "get_recent_role_changes");
    await handler({});

    expect(requests).toHaveLength(1);
    expect(requests[0].headers["ConsistencyLevel"]).toBe("eventual");
    expect(requests[0].filters).toHaveLength(1);
    expect(requests[0].filters[0]).toContain("category eq 'RoleManagement'");
  });

  it("applies userFilter as an in-memory post-filter without issuing a second Graph call", async () => {
    const { requests } = queueGraphResponses([{ data: { value: SAMPLE_ENTRIES } }]);

    const handler = captureToolHandler(registerGetRecentRoleChanges, "get_recent_role_changes");
    const result = await handler({ userFilter: "alexis" });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.changes).toHaveLength(1);
    expect(parsed.changes[0].targetResources[0].displayName).toBe("Alexis Chen");

    expect(requests).toHaveLength(1);
  });

  it("follows @odata.nextLink until the date window is fully paged", async () => {
    const page1 = [SAMPLE_ENTRIES[0]];
    const page2 = [SAMPLE_ENTRIES[1], SAMPLE_ENTRIES[2]];
    const nextLink = "https://graph.microsoft.com/v1.0/auditLogs/directoryAudits?$skiptoken=page2";

    const { requests } = queueGraphResponses([
      { data: { value: page1, "@odata.nextLink": nextLink } },
      { data: { value: page2 } },
    ]);

    const handler = captureToolHandler(registerGetRecentRoleChanges, "get_recent_role_changes");
    const result = await handler({ days: 30 });

    const parsed = JSON.parse(result.content[0].text);
    expect(result.isError).toBeUndefined();
    expect(parsed.changes).toHaveLength(3);
    expect(parsed.truncated).toBeUndefined();

    expect(requests).toHaveLength(2);
    expect(requests[0].path).toBe("/auditLogs/directoryAudits");
    expect(requests[0].top).toBe(100);
    expect(requests[0].headers["ConsistencyLevel"]).toBe("eventual");
    expect(requests[1].path).toBe(nextLink);
    expect(requests[1].headers["ConsistencyLevel"]).toBe("eventual");
  });

  it("applies userFilter across all pages, not just the first", async () => {
    const nextLink = "https://graph.microsoft.com/v1.0/auditLogs/directoryAudits?$skiptoken=page2";
    queueGraphResponses([
      { data: { value: [SAMPLE_ENTRIES[0]], "@odata.nextLink": nextLink } },
      { data: { value: [SAMPLE_ENTRIES[1]] } },
    ]);

    const handler = captureToolHandler(registerGetRecentRoleChanges, "get_recent_role_changes");
    const result = await handler({ userFilter: "alexis" });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.changes).toHaveLength(1);
    expect(parsed.changes[0].targetResources[0].displayName).toBe("Alexis Chen");
  });

  it("slices to limit after paging and sets truncated:true when more matches exist", async () => {
    queueGraphResponses([{ data: { value: SAMPLE_ENTRIES } }]);

    const handler = captureToolHandler(registerGetRecentRoleChanges, "get_recent_role_changes");
    const result = await handler({ limit: 2 });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.changes).toHaveLength(2);
    expect(parsed.truncated).toBe(true);
  });

  it("returns a friendly isError result and logs status:error on a Graph failure", async () => {
    queueGraphResponses([{ error: new GraphError(403, "Forbidden") }]);

    const handler = captureToolHandler(registerGetRecentRoleChanges, "get_recent_role_changes");
    const result = await handler({});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).not.toMatch(/Forbidden/i);
    expect(result.content[0].text).toMatch(/permission|denied/i);

    expect(logToolCall).toHaveBeenCalledWith(expect.objectContaining({ tool: "get_recent_role_changes", status: "error" }));
  });

  // Regression test for a live finding: asking for a day window Graph
  // can't actually serve (older than this tenant's confirmed 30-day audit
  // retention) previously surfaced as an opaque "status 400, code
  // UnknownError" with no indication of why - which led to a wrong guess
  // about retention being ~2 weeks. classifyGraphError now recognizes
  // Graph's actual error text for this case; this confirms that message
  // reaches the tool's result instead of the generic fallback.
  it("surfaces a retention-window-specific message when Graph rejects a date filter past the tenant's retention", async () => {
    const retentionError = new GraphError(
      400,
      "Specified argument was out of the range of valid values. (Parameter 'Minimum allowed time for activityDateTime is 6/12/2026 12:00:00 AM')",
    );
    retentionError.code = "UnknownError";
    queueGraphResponses([{ error: retentionError }]);

    const handler = captureToolHandler(registerGetRecentRoleChanges, "get_recent_role_changes");
    const result = await handler({ days: 30 });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/retention window/i);
    expect(result.content[0].text).not.toMatch(/UnknownError/);

    expect(logToolCall).toHaveBeenCalledWith(expect.objectContaining({ tool: "get_recent_role_changes", status: "error" }));
  });

  it("explicit tenant GUID behaves identically to omitting the tenant field", async () => {
    queueGraphResponses([{ data: { value: SAMPLE_ENTRIES } }]);
    const handler = captureToolHandler(registerGetRecentRoleChanges, "get_recent_role_changes");

    const result = await handler({ tenant: process.env.AZURE_TENANT_ID });

    expect(result.isError).toBeUndefined();
    expect(logToolCall).toHaveBeenCalledWith(expect.objectContaining({ tool: "get_recent_role_changes", status: "success" }));
  });

  it("unknown tenant returns isError:true and validation_error with no Graph calls", async () => {
    const { requests } = queueGraphResponses([]);
    const handler = captureToolHandler(registerGetRecentRoleChanges, "get_recent_role_changes");

    const result = await handler({ tenant: "does-not-exist" });

    expect(result.isError).toBe(true);
    expect(requests).toHaveLength(0);
    expect(logToolCall).toHaveBeenCalledWith(expect.objectContaining({ tool: "get_recent_role_changes", status: "validation_error" }));
  });
});
