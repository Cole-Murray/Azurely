import { getServerConfig, resetServerConfigCacheForTests } from "../../../src/config/serverConfig";

// Unlike env.test.ts, no jest.mock("dotenv") is needed here - serverConfig.ts
// deliberately never calls dotenv's config() itself (see its module
// docblock), so there's no risk of a real .env file re-populating a var a
// test deletes.
const originalEnv = { ...process.env };

const SERVER_CONFIG_VARS = [
  "MCP_TRANSPORT",
  "PORT",
  "MCP_HTTP_HOST",
  "MCP_HTTP_PATH",
  "MCP_ALLOWED_HOSTS",
  "MCP_KEYVAULT_MAX_ATTEMPTS",
] as const;

function clearServerConfigVars(): void {
  for (const key of SERVER_CONFIG_VARS) {
    delete process.env[key];
  }
}

beforeEach(() => {
  resetServerConfigCacheForTests();
  clearServerConfigVars();
});

afterEach(() => {
  process.env = { ...originalEnv };
  resetServerConfigCacheForTests();
});

describe("getServerConfig", () => {
  it("returns all defaults on a bare environment", () => {
    const config = getServerConfig();

    expect(config).toEqual({
      transport: "stdio",
      port: 8080,
      host: "127.0.0.1",
      path: "/mcp",
      allowedHosts: undefined,
      keyVaultMaxAttempts: 5,
    });
  });

  it("honors MCP_TRANSPORT=http", () => {
    process.env.MCP_TRANSPORT = "http";

    const config = getServerConfig();

    expect(config.transport).toBe("http");
  });

  it("throws on an invalid MCP_TRANSPORT value", () => {
    process.env.MCP_TRANSPORT = "grpc";

    expect(() => getServerConfig()).toThrow();
  });

  it("coerces a string PORT to a number", () => {
    process.env.PORT = "3000";

    const config = getServerConfig();

    expect(config.port).toBe(3000);
  });

  it("throws on an out-of-range PORT", () => {
    process.env.PORT = "70000";

    expect(() => getServerConfig()).toThrow();
  });

  it("parses MCP_ALLOWED_HOSTS into a trimmed, empty-filtered array", () => {
    process.env.MCP_ALLOWED_HOSTS = "a.com, b.com ,";

    const config = getServerConfig();

    expect(config.allowedHosts).toEqual(["a.com", "b.com"]);
  });

  // A set-but-effectively-empty value must degrade to "no restriction
  // configured", not to an empty allow-list. The SDK's host-validation
  // middleware reads an empty list as "permit nothing", so returning []
  // here would reject every request - a total lockout from a typo, which
  // would present as a broken server rather than as a config mistake.
  it.each(['","', '"  "', '", ,"'])("treats MCP_ALLOWED_HOSTS=%s as unset rather than an empty allow-list", (raw) => {
    process.env.MCP_ALLOWED_HOSTS = raw.replaceAll('"', "");

    const config = getServerConfig();

    expect(config.allowedHosts).toBeUndefined();
  });

  it("memoizes across calls and does not pick up a later process.env change until reset", () => {
    process.env.PORT = "3000";

    const first = getServerConfig();
    process.env.PORT = "4000";
    const second = getServerConfig();

    expect(second).toBe(first);
    expect(second.port).toBe(3000);

    resetServerConfigCacheForTests();
    const third = getServerConfig();

    expect(third.port).toBe(4000);
    expect(third).not.toBe(first);
  });
});
