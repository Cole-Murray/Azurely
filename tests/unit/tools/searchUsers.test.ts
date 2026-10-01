import { GraphError } from "@microsoft/microsoft-graph-client";
import { logToolCall } from "../../../src/audit/logger";
import { resetEnvCacheForTests } from "../../../src/config/env";
import { registerSearchUsers } from "../../../src/tools/searchUsers";
import { queueGraphResponses } from "../../helpers/fakeGraphClient";
import { captureToolHandler } from "../../helpers/mcpTestServer";

jest.mock("../../../src/graph/client");
jest.mock("../../../src/audit/logger");

const originalEnv = { ...process.env };

const SAMPLE_USERS = [
  {
    id: "11111111-1111-1111-1111-111111111111",
    displayName: "Alex Rivera",
    userPrincipalName: "alex.rivera@contoso.example",
    mail: "alex.rivera@contoso.example",
    accountEnabled: true,
  },
  {
    id: "22222222-2222-2222-2222-222222222222",
    displayName: "Alexis Chen",
    userPrincipalName: "alexis.chen@contoso.example",
    mail: "alexis.chen@contoso.example",
    accountEnabled: true,
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

describe("search_users tool", () => {
  it("returns matches and truncated:false when fewer results than the limit come back", async () => {
    queueGraphResponses([{ data: { value: SAMPLE_USERS } }]);

    const handler = captureToolHandler(registerSearchUsers, "search_users");
    const result = await handler({ query: "alex" });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.matches).toHaveLength(2);
    expect(parsed.truncated).toBe(false);
    expect(result.isError).toBeUndefined();

    expect(logToolCall).toHaveBeenCalledWith(expect.objectContaining({ tool: "search_users", status: "success" }));
  });

  it("sets truncated:true when the result count equals the requested limit", async () => {
    queueGraphResponses([{ data: { value: SAMPLE_USERS } }]);

    const handler = captureToolHandler(registerSearchUsers, "search_users");
    const result = await handler({ query: "alex", limit: 2 });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.matches).toHaveLength(2);
    expect(parsed.truncated).toBe(true);
  });

  it("issues the Graph request with ConsistencyLevel: eventual", async () => {
    const { requests } = queueGraphResponses([{ data: { value: SAMPLE_USERS } }]);

    const handler = captureToolHandler(registerSearchUsers, "search_users");
    await handler({ query: "alex" });

    expect(requests).toHaveLength(1);
    expect(requests[0].headers["ConsistencyLevel"]).toBe("eventual");
  });

  it("returns a friendly isError result and logs status:error on a Graph failure", async () => {
    queueGraphResponses([{ error: new GraphError(403, "Forbidden") }]);

    const handler = captureToolHandler(registerSearchUsers, "search_users");
    const result = await handler({ query: "alex" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).not.toMatch(/Forbidden/i);
    expect(result.content[0].text).toMatch(/permission|denied/i);

    expect(logToolCall).toHaveBeenCalledWith(expect.objectContaining({ tool: "search_users", status: "error" }));
  });

  it("explicit tenant GUID behaves identically to omitting the tenant field", async () => {
    queueGraphResponses([{ data: { value: SAMPLE_USERS } }]);
    const handler = captureToolHandler(registerSearchUsers, "search_users");

    const result = await handler({ query: "alex", tenant: process.env.AZURE_TENANT_ID });

    expect(result.isError).toBeUndefined();
    expect(logToolCall).toHaveBeenCalledWith(expect.objectContaining({ tool: "search_users", status: "success" }));
  });

  it("unknown tenant returns isError:true and validation_error with no Graph calls", async () => {
    const { requests } = queueGraphResponses([]);
    const handler = captureToolHandler(registerSearchUsers, "search_users");

    const result = await handler({ query: "alex", tenant: "does-not-exist" });

    expect(result.isError).toBe(true);
    expect(requests).toHaveLength(0);
    expect(logToolCall).toHaveBeenCalledWith(expect.objectContaining({ tool: "search_users", status: "validation_error" }));
  });
});
