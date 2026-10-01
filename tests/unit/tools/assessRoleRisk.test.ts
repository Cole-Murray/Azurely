import { GraphError } from "@microsoft/microsoft-graph-client";
import { queueGraphResponses } from "../../helpers/fakeGraphClient";
import { captureToolHandler } from "../../helpers/mcpTestServer";
import { resetEnvCacheForTests } from "../../../src/config/env";
import type { RoleDefinition } from "../../../src/cache/roleDefinitionsCache";
import type { RoleAssignmentsResult } from "../../../src/tools/getRoleAssignments";

// This tool composes get_role_assignments and resolveRoleDefinition rather
// than calling Graph for either itself, so both are mocked directly - their
// own correctness (Graph query shape, name-matching rules) is already
// covered by getRoleAssignments.test.ts / roleLookup's own tests. Only the
// PIM schedule-instance calls go through the real (fake) Graph client, since
// wiring the role-centric $filter for those is specifically this tool's job.
jest.mock("../../../src/tools/getRoleAssignments");
jest.mock("../../../src/tools/shared/roleLookup");
jest.mock("../../../src/graph/client");
jest.mock("../../../src/audit/logger");

import { getRoleAssignmentsCore } from "../../../src/tools/getRoleAssignments";
import { resolveRoleDefinition } from "../../../src/tools/shared/roleLookup";
import { logToolCall } from "../../../src/audit/logger";
import { registerAssessRoleRisk } from "../../../src/tools/assessRoleRisk";

const GLOBAL_ADMIN: RoleDefinition = { id: "role-global-admin", displayName: "Global Administrator", isBuiltIn: true };
const PRIV_ROLE_ADMIN: RoleDefinition = { id: "role-priv-role-admin", displayName: "Privileged Role Administrator", isBuiltIn: true };

const DIRECT_HOLDER = { principalId: "user-1", principalType: "user", principalDisplayName: "Alex Example" };
const TRANSITIVE_HOLDER = { principalId: "group-member-1", principalType: "user", principalDisplayName: "Jamie Example", viaGroupId: "group-1" };

async function runAssessRoleRisk(args: Record<string, unknown> = {}): Promise<{ payload: any; result: { isError?: boolean } }> {
  const handler = captureToolHandler(registerAssessRoleRisk, "assess_role_risk");
  const result = (await handler(args)) as { content: { type: string; text: string }[]; isError?: boolean };
  const payload = result.content?.[0]?.text ? JSON.parse(result.content[0].text) : undefined;
  return { payload, result };
}

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

describe("assess_role_risk", () => {
  it("flags a standing direct holder as high and a transitive holder as medium", async () => {
    (resolveRoleDefinition as jest.Mock).mockResolvedValue(GLOBAL_ADMIN);
    (getRoleAssignmentsCore as jest.Mock).mockResolvedValue({
      role: { id: GLOBAL_ADMIN.id, displayName: GLOBAL_ADMIN.displayName },
      direct: [DIRECT_HOLDER],
      transitive: [TRANSITIVE_HOLDER],
    } satisfies RoleAssignmentsResult);
    // No PIM-active instance for anyone, and eligible is irrelevant here.
    queueGraphResponses([{ data: { value: [] } }, { data: { value: [] } }]);

    const { payload, result } = await runAssessRoleRisk({ roleNames: ["Global Administrator"] });

    expect(result.isError).toBeUndefined();
    expect(payload.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ severity: "high", principalId: DIRECT_HOLDER.principalId, reason: expect.stringContaining("standing (non-PIM)") }),
        expect.objectContaining({ severity: "medium", principalId: TRANSITIVE_HOLDER.principalId, reason: expect.stringContaining("group membership") }),
      ]),
    );
    expect(logToolCall).toHaveBeenCalledWith(expect.objectContaining({ tool: "assess_role_risk", status: "success" }));
  });

  it("does not flag a direct holder that has a matching PIM-active instance", async () => {
    (resolveRoleDefinition as jest.Mock).mockResolvedValue(GLOBAL_ADMIN);
    (getRoleAssignmentsCore as jest.Mock).mockResolvedValue({
      role: { id: GLOBAL_ADMIN.id, displayName: GLOBAL_ADMIN.displayName },
      direct: [DIRECT_HOLDER],
      transitive: [],
    } satisfies RoleAssignmentsResult);
    queueGraphResponses([
      { data: { value: [{ id: "sched-1", principalId: DIRECT_HOLDER.principalId, roleDefinitionId: GLOBAL_ADMIN.id, assignmentType: "Activated" }] } },
      { data: { value: [] } },
    ]);

    const { payload, result } = await runAssessRoleRisk({ roleNames: ["Global Administrator"] });

    expect(result.isError).toBeUndefined();
    expect(payload.findings.filter((f: any) => f.severity === "high")).toHaveLength(0);
    expect(logToolCall).toHaveBeenCalledWith(expect.objectContaining({ tool: "assess_role_risk", status: "success" }));
  });

  it("still flags a direct holder as high when their schedule instance is a standing 'Assigned' record, not a time-boxed PIM activation", async () => {
    (resolveRoleDefinition as jest.Mock).mockResolvedValue(GLOBAL_ADMIN);
    (getRoleAssignmentsCore as jest.Mock).mockResolvedValue({
      role: { id: GLOBAL_ADMIN.id, displayName: GLOBAL_ADMIN.displayName },
      direct: [DIRECT_HOLDER],
      transitive: [],
    } satisfies RoleAssignmentsResult);
    queueGraphResponses([
      { data: { value: [{ id: "sched-1", principalId: DIRECT_HOLDER.principalId, roleDefinitionId: GLOBAL_ADMIN.id, assignmentType: "Assigned" }] } },
      { data: { value: [] } },
    ]);

    const { payload, result } = await runAssessRoleRisk({ roleNames: ["Global Administrator"] });

    expect(result.isError).toBeUndefined();
    expect(payload.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ severity: "high", principalId: DIRECT_HOLDER.principalId, reason: expect.stringContaining("standing (non-PIM)") }),
      ]),
    );
    expect(logToolCall).toHaveBeenCalledWith(expect.objectContaining({ tool: "assess_role_risk", status: "success" }));
  });

  it("adds an info finding when the same principal holds two assessed high-risk roles", async () => {
    (resolveRoleDefinition as jest.Mock).mockImplementation((_tenantId: string, input: { roleName?: string }) => {
      if (input.roleName === "Global Administrator") return Promise.resolve(GLOBAL_ADMIN);
      if (input.roleName === "Privileged Role Administrator") return Promise.resolve(PRIV_ROLE_ADMIN);
      throw new Error(`unexpected roleName ${input.roleName}`);
    });
    (getRoleAssignmentsCore as jest.Mock).mockImplementation((_tenantId: string, role: RoleDefinition) => {
      return Promise.resolve({
        role: { id: role.id, displayName: role.displayName },
        direct: [DIRECT_HOLDER],
        transitive: [],
      } satisfies RoleAssignmentsResult);
    });
    // Two roles x (active + eligible) = 4 sequential PIM calls, none of which find an active match.
    queueGraphResponses([{ data: { value: [] } }, { data: { value: [] } }, { data: { value: [] } }, { data: { value: [] } }]);

    const { payload, result } = await runAssessRoleRisk({ roleNames: ["Global Administrator", "Privileged Role Administrator"] });

    expect(result.isError).toBeUndefined();
    expect(payload.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "info",
          principalId: DIRECT_HOLDER.principalId,
          reason: expect.stringContaining("holds multiple high-risk roles"),
        }),
      ]),
    );
    expect(logToolCall).toHaveBeenCalledWith(expect.objectContaining({ tool: "assess_role_risk", status: "success" }));
  });

  it("degrades gracefully when PIM data is unavailable (non-P2 tenant), still returning findings", async () => {
    (resolveRoleDefinition as jest.Mock).mockResolvedValue(GLOBAL_ADMIN);
    (getRoleAssignmentsCore as jest.Mock).mockResolvedValue({
      role: { id: GLOBAL_ADMIN.id, displayName: GLOBAL_ADMIN.displayName },
      direct: [DIRECT_HOLDER],
      transitive: [],
    } satisfies RoleAssignmentsResult);
    queueGraphResponses([{ error: new GraphError(403, "Forbidden") }, { data: { value: [] } }]);

    const { payload, result } = await runAssessRoleRisk({ roleNames: ["Global Administrator"] });

    expect(result.isError).toBeUndefined();
    expect(payload.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "high",
          principalId: DIRECT_HOLDER.principalId,
          reason: expect.stringContaining("PIM status unknown - Entra ID P2 data unavailable"),
        }),
      ]),
    );
    expect(logToolCall).toHaveBeenCalledWith(expect.objectContaining({ tool: "assess_role_risk", status: "success" }));
  });

  it("explicit tenant GUID behaves identically to omitting the tenant field", async () => {
    (resolveRoleDefinition as jest.Mock).mockResolvedValue(GLOBAL_ADMIN);
    (getRoleAssignmentsCore as jest.Mock).mockResolvedValue({
      role: { id: GLOBAL_ADMIN.id, displayName: GLOBAL_ADMIN.displayName },
      direct: [DIRECT_HOLDER],
      transitive: [],
    } satisfies RoleAssignmentsResult);
    queueGraphResponses([{ data: { value: [] } }, { data: { value: [] } }]);

    const { result } = await runAssessRoleRisk({ roleNames: ["Global Administrator"], tenant: process.env.AZURE_TENANT_ID });

    expect(result.isError).toBeUndefined();
    expect(logToolCall).toHaveBeenCalledWith(expect.objectContaining({ tool: "assess_role_risk", status: "success" }));
  });

  it("unknown tenant returns isError:true and validation_error with no Graph calls", async () => {
    const { requests } = queueGraphResponses([]);
    const handler = captureToolHandler(registerAssessRoleRisk, "assess_role_risk");

    const result = await handler({ roleNames: ["Global Administrator"], tenant: "does-not-exist" });

    expect(result.isError).toBe(true);
    expect(requests).toHaveLength(0);
    expect(logToolCall).toHaveBeenCalledWith(expect.objectContaining({ tool: "assess_role_risk", status: "validation_error" }));
  });
});
