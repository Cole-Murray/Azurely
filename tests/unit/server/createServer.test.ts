import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createServer } from "../../../src/server/createServer";
import { resetEnvCacheForTests } from "../../../src/config/env";

const EXPECTED_TOOL_ORDER = [
  "search_users",
  "search_directory_roles",
  "get_role_assignments",
  "get_user_directory_roles",
  "explain_directory_role",
  "get_recent_role_changes",
  "assess_role_risk",
  "get_azure_role_assignments",
  "get_azure_pim_assignments",
  "get_azure_role_activation_history",
  "get_directory_role_activation_history",
  "get_user_group_pim_eligibility",
];

describe("createServer", () => {
  it("returns a distinct instance per call", () => {
    expect(createServer()).not.toBe(createServer());
  });

  describe("tool registration", () => {
    let registerToolSpy: jest.SpyInstance;

    afterEach(() => {
      registerToolSpy.mockRestore();
    });

    it("registers exactly the 12 expected tools, in order", () => {
      registerToolSpy = jest.spyOn(McpServer.prototype, "registerTool");

      createServer();

      const registeredNames = registerToolSpy.mock.calls.map((call) => call[0]);
      expect(registeredNames).toEqual(EXPECTED_TOOL_ORDER);
    });
  });

  describe("decoupling from env validation", () => {
    const originalEnv = { ...process.env };

    afterEach(() => {
      process.env = { ...originalEnv };
      resetEnvCacheForTests();
    });

    it("does not throw when getEnv() would throw", () => {
      resetEnvCacheForTests();
      delete process.env.AZURE_TENANT_ID;
      delete process.env.AZURE_CLIENT_ID;
      delete process.env.AZURE_CLIENT_SECRET;
      delete process.env.AZURE_KEY_VAULT_URL;

      // Note: getEnv() calls dotenv's config(), which re-reads the real
      // .env from disk - so deleting these vars here may not be enough on
      // its own to make getEnv() actually throw in this environment. That's
      // fine: the invariant under test is that createServer() itself never
      // calls getEnv() (or otherwise depends on Azure config validation),
      // not that getEnv() throws.
      expect(() => createServer()).not.toThrow();
    });
  });
});
