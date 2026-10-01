import request from "supertest";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { buildHttpApp, type HttpServerDeps } from "../../../src/http/httpServer";
import { markFailed, markReady, resetReadinessForTests } from "../../../src/http/readiness";
import type { ServerConfig } from "../../../src/config/serverConfig";

// This suite never binds a socket (buildHttpApp never calls listen()) and
// never calls startHttpServer, so no real Azure/Key Vault/Graph call is
// reachable from it. These two modules are mocked anyway, per this
// project's convention (see tests/unit/config/keyVault.test.ts), since
// src/http/httpServer.ts imports both at module scope for its credential
// warm-up path (only exercised by startHttpServer, never by buildHttpApp).
jest.mock("../../../src/config/env", () => ({
  getEnv: jest.fn(() => ({ AZURE_TENANT_ID: "fake-tenant", AZURE_CLIENT_ID: "fake-client" })),
}));
jest.mock("../../../src/config/keyVault", () => ({
  loadClientSecretFromKeyVault: jest.fn(),
}));

// The last test below (audit actor attribution) calls the real search_users
// tool end to end - through runTool/logToolCall, exactly like production -
// to prove caller identity reaches the audit log. searchUsersCore is the one
// thing mocked out, so that call never reaches a real credential or Graph:
// this is a unit test, and CLAUDE.md/this repo's convention is that unit
// tests never call live Graph (see tests/unit/config/keyVault.test.ts for
// the same jest.mock-the-module-boundary pattern).
jest.mock("../../../src/graph/userDirectory", () => ({
  searchUsersCore: jest.fn().mockResolvedValue([]),
}));

const testConfig: ServerConfig = {
  transport: "http",
  port: 0,
  host: "127.0.0.1",
  path: "/mcp",
  allowedHosts: undefined,
  keyVaultMaxAttempts: 5,
};

const MCP_ACCEPT = "application/json, text/event-stream";

/** A stub OAuthTokenVerifier - never constructs or validates a real Entra JWT. */
function stubVerifier(oid: string): OAuthTokenVerifier {
  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      if (token !== "valid-token") {
        throw new InvalidTokenError("stub: invalid token");
      }
      return {
        token,
        clientId: "stub-client-id",
        scopes: ["iam.read"],
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        extra: { oid, upn: `${oid}@example.com` },
      };
    },
  };
}

function initializeBody(id: number | string = 1) {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test-client", version: "1.0.0" },
    },
  };
}

function toolsListBody(id: number | string = 1) {
  return { jsonrpc: "2.0", id, method: "tools/list", params: {} };
}

afterEach(() => {
  resetReadinessForTests();
  jest.restoreAllMocks();
});

describe("GET /healthz", () => {
  it("returns 200 even while readiness is still 'starting' - proves liveness has no credential dependency", () => {
    // resetReadinessForTests() in afterEach already guarantees "starting" as
    // the default, but assert it explicitly so this test still documents
    // the property even if that default ever changes.
    const app = buildHttpApp(testConfig);
    return request(app)
      .get("/healthz")
      .expect(200)
      .then((res) => {
        expect(res.body).toMatchObject({ status: "ok" });
      });
  });
});

describe("GET /readyz", () => {
  it("returns 503 while starting, 200 once ready, and 503 again once failed", async () => {
    const app = buildHttpApp(testConfig);

    const startingRes = await request(app).get("/readyz");
    expect(startingRes.status).toBe(503);
    expect(startingRes.body.status).toBe("starting");

    markReady();
    const readyRes = await request(app).get("/readyz");
    expect(readyRes.status).toBe(200);
    expect(readyRes.body.status).toBe("ready");

    markFailed("keyvault: access denied fetching azure-client-secret", 5);
    const failedRes = await request(app).get("/readyz");
    expect(failedRes.status).toBe(503);
    expect(failedRes.body).toMatchObject({ status: "failed", reason: "keyvault: access denied fetching azure-client-secret", attempts: 5 });
  });
});

describe("POST <path> before ready", () => {
  it("returns 503 with a JSON-RPC-shaped error body", async () => {
    const app = buildHttpApp(testConfig);
    const res = await request(app)
      .post("/mcp")
      .set("Accept", MCP_ACCEPT)
      .set("Content-Type", "application/json")
      .send(toolsListBody());

    expect(res.status).toBe(503);
    expect(res.body.jsonrpc).toBe("2.0");
    expect(res.body.error).toBeDefined();
    expect(typeof res.body.error.message).toBe("string");
  });
});

describe("GET/DELETE <path>", () => {
  it("both return 405 with Allow: POST", async () => {
    const app = buildHttpApp(testConfig);

    const getRes = await request(app).get("/mcp");
    expect(getRes.status).toBe(405);
    expect(getRes.headers.allow).toBe("POST");
    expect(getRes.body.jsonrpc).toBe("2.0");

    const deleteRes = await request(app).delete("/mcp");
    expect(deleteRes.status).toBe(405);
    expect(deleteRes.headers.allow).toBe("POST");
    expect(deleteRes.body.jsonrpc).toBe("2.0");
  });
});

describe("statelessness", () => {
  it("an initialize response carries no mcp-session-id header", async () => {
    markReady();
    const app = buildHttpApp(testConfig);

    const res = await request(app)
      .post("/mcp")
      .set("Accept", MCP_ACCEPT)
      .set("Content-Type", "application/json")
      .send(initializeBody());

    expect(res.status).toBe(200);
    // Pins the stateless design: if someone later adds a sessionIdGenerator,
    // this header appears and this assertion fails.
    expect(res.headers["mcp-session-id"]).toBeUndefined();
  });
});

describe("POST tools/list", () => {
  it("returns all 12 registered tools, including search_users", async () => {
    markReady();
    const app = buildHttpApp(testConfig);

    const res = await request(app)
      .post("/mcp")
      .set("Accept", MCP_ACCEPT)
      .set("Content-Type", "application/json")
      .send(toolsListBody());

    expect(res.status).toBe(200);
    const tools = res.body.result.tools;
    expect(Array.isArray(tools)).toBe(true);
    expect(tools).toHaveLength(12);
    expect(tools.map((t: { name: string }) => t.name)).toContain("search_users");
  });
});

describe("negative header cases", () => {
  it("406 when Accept is missing text/event-stream", async () => {
    markReady();
    const app = buildHttpApp(testConfig);

    const res = await request(app)
      .post("/mcp")
      .set("Accept", "application/json")
      .set("Content-Type", "application/json")
      .send(toolsListBody());

    expect(res.status).toBe(406);
  });

  it("415 when Content-Type is not application/json", async () => {
    markReady();
    const app = buildHttpApp(testConfig);

    const res = await request(app)
      .post("/mcp")
      .set("Accept", MCP_ACCEPT)
      .set("Content-Type", "text/plain")
      .send(JSON.stringify(toolsListBody()));

    expect(res.status).toBe(415);
  });
});

describe("protected-resource metadata", () => {
  const deps: HttpServerDeps = {
    oauth: {
      tenantId: "11111111-1111-1111-1111-111111111111",
      requiredScope: "iam.read",
      canonicalResource: "https://mcp.example.com/mcp",
    },
  };

  it("is served, unauthenticated, at /.well-known/oauth-protected-resource/mcp", async () => {
    const app = buildHttpApp(testConfig, deps);
    const res = await request(app).get("/.well-known/oauth-protected-resource/mcp");

    expect(res.status).toBe(200);
    expect(res.body.resource).toBe("https://mcp.example.com/mcp");
    expect(res.body.authorization_servers).toEqual(["https://login.microsoftonline.com/11111111-1111-1111-1111-111111111111/v2.0"]);
  });

  it("is also served at /.well-known/oauth-protected-resource", async () => {
    const app = buildHttpApp(testConfig, deps);
    const res = await request(app).get("/.well-known/oauth-protected-resource");

    expect(res.status).toBe(200);
    expect(res.body.resource).toBe("https://mcp.example.com/mcp");
    expect(res.body.authorization_servers).toEqual(["https://login.microsoftonline.com/11111111-1111-1111-1111-111111111111/v2.0"]);
  });

  // RFC 9728 (and the MCP spec, restating it as a MUST) requires
  // authorization_servers to name at least one server. With no inbound auth
  // configured there is nothing truthful to advertise, so the route is not
  // mounted at all rather than served with an empty array - an empty array
  // would parse fine on the client and leave it with no authorization server
  // and no way to tell that apart from a broken deployment.
  it.each(["/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource"])(
    "is NOT served at %s when no inbound auth is configured",
    async (path) => {
      const app = buildHttpApp(testConfig, {});
      const res = await request(app).get(path);

      expect(res.status).toBe(404);
      expect(res.body.authorization_servers).toBeUndefined();
    },
  );
});

describe("with a verifier configured", () => {
  it("401s a request with no Authorization header, and WWW-Authenticate contains resource_metadata=", async () => {
    markReady();
    const app = buildHttpApp(testConfig, {
      verifier: stubVerifier("caller-oid-123"),
      oauth: {
        tenantId: "11111111-1111-1111-1111-111111111111",
        requiredScope: "iam.read",
        canonicalResource: "https://mcp.example.com/mcp",
      },
    });

    const res = await request(app)
      .post("/mcp")
      .set("Accept", MCP_ACCEPT)
      .set("Content-Type", "application/json")
      .send(toolsListBody());

    expect(res.status).toBe(401);
    expect(res.headers["www-authenticate"]).toEqual(expect.stringContaining("resource_metadata="));
  });

  it("a successful verification lets tools/list through and attributes the audit log to the token's oid", async () => {
    markReady();
    const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    const app = buildHttpApp(testConfig, {
      verifier: stubVerifier("caller-oid-456"),
      oauth: {
        tenantId: "11111111-1111-1111-1111-111111111111",
        requiredScope: "iam.read",
        canonicalResource: "https://mcp.example.com/mcp",
      },
    });

    const res = await request(app)
      .post("/mcp")
      .set("Accept", MCP_ACCEPT)
      .set("Content-Type", "application/json")
      .set("Authorization", "Bearer valid-token")
      .send(toolsListBody());

    expect(res.status).toBe(200);
    expect(res.body.result.tools).toHaveLength(12);

    // The MCP SDK's tools/list handler doesn't run through runTool/logToolCall
    // (that only wraps actual tool *invocations*, not the list request), so
    // this test can't assert on tools/list itself producing an audit line -
    // it instead calls a real tool (search_users) in the same authenticated
    // request stream to prove identity reaches the audit log end to end.
    const searchUsersRes = await request(app)
      .post("/mcp")
      .set("Accept", MCP_ACCEPT)
      .set("Content-Type", "application/json")
      .set("Authorization", "Bearer valid-token")
      .send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "search_users", arguments: { query: "someone" } },
      });
    expect(searchUsersRes.status).toBe(200);

    const auditLines = consoleErrorSpy.mock.calls.map((call) => String(call[0])).filter((line) => line.startsWith("[audit] "));
    expect(auditLines.length).toBeGreaterThan(0);
    const lastAuditEntry = JSON.parse(auditLines[auditLines.length - 1].slice("[audit] ".length));
    expect(lastAuditEntry.actor).toBe("caller-oid-456");
  });
});
