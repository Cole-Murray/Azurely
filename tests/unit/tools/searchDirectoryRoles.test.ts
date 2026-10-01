import { queueGraphResponses } from "../../helpers/fakeGraphClient";
import { captureToolHandler } from "../../helpers/mcpTestServer";
import { clearRoleDefinitionsCacheForTests } from "../../../src/cache/roleDefinitionsCache";
import { resetEnvCacheForTests } from "../../../src/config/env";

jest.mock("../../../src/graph/client");
jest.mock("../../../src/audit/logger");

import { logToolCall } from "../../../src/audit/logger";
import { registerSearchDirectoryRoles } from "../../../src/tools/searchDirectoryRoles";

const SAMPLE_ROLES = [
  { id: "role-1", displayName: "Global Administrator", description: "Can manage all aspects of Entra ID.", isBuiltIn: true },
  { id: "role-2", displayName: "User Administrator", description: "Can manage users and groups.", isBuiltIn: true },
  { id: "role-3", displayName: "Custom Helpdesk Role", description: "Reset passwords for non-admins.", isBuiltIn: false },
];

const originalEnv = { ...process.env };

beforeEach(() => {
  clearRoleDefinitionsCacheForTests();
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

describe("search_directory_roles", () => {
  it("returns every role when no query is given", async () => {
    const fake = queueGraphResponses([{ data: { value: SAMPLE_ROLES } }]);
    const handler = captureToolHandler(registerSearchDirectoryRoles, "search_directory_roles");

    const result = await handler({});
    const payload = JSON.parse(result.content[0].text);

    expect(payload.query).toBeNull();
    expect(payload.matches).toHaveLength(3);
    expect(fake.requests).toHaveLength(1);
  });

  it("filters in memory without issuing a second Graph call", async () => {
    const fake = queueGraphResponses([{ data: { value: SAMPLE_ROLES } }]);
    const handler = captureToolHandler(registerSearchDirectoryRoles, "search_directory_roles");

    // Different case than the stored "Global Administrator" name.
    const result = await handler({ query: "global admin" });
    const payload = JSON.parse(result.content[0].text);

    expect(payload.matches).toHaveLength(1);
    expect(payload.matches[0].displayName).toBe("Global Administrator");
    expect(fake.requests).toHaveLength(1);
  });

  it("serves a second call from the role definitions cache", async () => {
    const fake = queueGraphResponses([{ data: { value: SAMPLE_ROLES } }]);
    const handler = captureToolHandler(registerSearchDirectoryRoles, "search_directory_roles");

    await handler({});
    // Only one response was ever queued - a second Graph hit here would
    // throw "no queued response", so a clean second call proves caching.
    const result = await handler({ query: "user" });
    const payload = JSON.parse(result.content[0].text);

    expect(payload.matches).toHaveLength(1);
    expect(payload.matches[0].displayName).toBe("User Administrator");
    expect(fake.requests).toHaveLength(1);
  });

  it("logs a success audit entry", async () => {
    queueGraphResponses([{ data: { value: SAMPLE_ROLES } }]);
    const handler = captureToolHandler(registerSearchDirectoryRoles, "search_directory_roles");

    await handler({});

    expect(logToolCall).toHaveBeenCalledWith(expect.objectContaining({ tool: "search_directory_roles", status: "success" }));
  });

  it("explicit tenant GUID behaves identically to omitting the tenant field", async () => {
    queueGraphResponses([{ data: { value: SAMPLE_ROLES } }]);
    const handler = captureToolHandler(registerSearchDirectoryRoles, "search_directory_roles");

    const result = await handler({ tenant: process.env.AZURE_TENANT_ID });

    expect(result.isError).toBeUndefined();
    expect(logToolCall).toHaveBeenCalledWith(expect.objectContaining({ tool: "search_directory_roles", status: "success" }));
  });

  it("unknown tenant returns isError:true and validation_error with no Graph calls", async () => {
    const { requests } = queueGraphResponses([]);
    const handler = captureToolHandler(registerSearchDirectoryRoles, "search_directory_roles");

    const result = await handler({ tenant: "does-not-exist" });

    expect(result.isError).toBe(true);
    expect(requests).toHaveLength(0);
    expect(logToolCall).toHaveBeenCalledWith(expect.objectContaining({ tool: "search_directory_roles", status: "validation_error" }));
  });
});
