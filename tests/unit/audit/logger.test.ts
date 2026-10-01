import { userInfo } from "node:os";
import { logToolCall } from "../../../src/audit/logger";
import { withCallerContext } from "../../../src/audit/callerContext";
import { resetServerConfigCacheForTests } from "../../../src/config/serverConfig";

const originalEnv = { ...process.env };

describe("logToolCall", () => {
  let consoleErrorSpy: jest.SpyInstance;
  let consoleLogSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    consoleLogSpy = jest.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    consoleLogSpy.mockRestore();
    process.env = { ...originalEnv };
    resetServerConfigCacheForTests();
  });

  it("logs via console.error, never console.log (stdout is protocol-reserved)", () => {
    logToolCall({ tool: "search_users", args: { query: "alex" }, status: "success" });

    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    expect(consoleLogSpy).not.toHaveBeenCalled();
  });

  it("includes the required audit fields", () => {
    logToolCall({ tool: "search_users", args: { query: "alex" }, status: "success" });

    const [line] = consoleErrorSpy.mock.calls[0] as [string];
    const entry = JSON.parse(line.replace("[audit] ", ""));

    expect(entry).toMatchObject({
      tool: "search_users",
      args: { query: "alex" },
      status: "success",
    });
    expect(typeof entry.timestamp).toBe("string");
    expect(typeof entry.actor).toBe("string");
  });

  it("redacts args whose key looks like a secret", () => {
    logToolCall({
      tool: "get_role_assignments",
      args: { clientSecret: "super-secret", accessToken: "abc.def.ghi", roleId: "abc-123" },
      status: "success",
    });

    const [line] = consoleErrorSpy.mock.calls[0] as [string];
    const entry = JSON.parse(line.replace("[audit] ", ""));

    expect(entry.args.clientSecret).toBe("[REDACTED]");
    expect(entry.args.accessToken).toBe("[REDACTED]");
    expect(entry.args.roleId).toBe("abc-123");
  });

  it("carries an error message through for failed calls", () => {
    logToolCall({ tool: "search_users", args: {}, status: "error", errorMessage: "Graph returned 500" });

    const [line] = consoleErrorSpy.mock.calls[0] as [string];
    const entry = JSON.parse(line.replace("[audit] ", ""));

    expect(entry.status).toBe("error");
    expect(entry.errorMessage).toBe("Graph returned 500");
  });

  it("takes actor/actorSource/actorUpn/requestId from the caller context when one is set", () => {
    withCallerContext(
      {
        actor: "0000-oid-1234",
        actorSource: "oauth:oid",
        actorUpn: "alex@example.com",
        requestId: "req-sync-1",
      },
      () => {
        logToolCall({ tool: "search_users", args: { query: "alex" }, status: "success" });
      },
    );

    const [line] = consoleErrorSpy.mock.calls[0] as [string];
    const entry = JSON.parse(line.replace("[audit] ", ""));

    expect(entry.actor).toBe("0000-oid-1234");
    expect(entry.actorSource).toBe("oauth:oid");
    expect(entry.actorUpn).toBe("alex@example.com");
    expect(entry.requestId).toBe("req-sync-1");
  });

  it("keeps the caller context attributed correctly across awaited work (real tool-body shape)", async () => {
    await withCallerContext(
      { actor: "async-actor-oid", actorSource: "oauth:oid", requestId: "req-async-1" },
      async () => {
        // Mirrors what a real tool body does: await a Graph/ARM call (or
        // several, paginated) before ever calling logToolCall.
        await Promise.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));

        logToolCall({ tool: "get_role_assignments", args: {}, status: "success" });
      },
    );

    const [line] = consoleErrorSpy.mock.calls[0] as [string];
    const entry = JSON.parse(line.replace("[audit] ", ""));

    expect(entry.actor).toBe("async-actor-oid");
    expect(entry.requestId).toBe("req-async-1");
  });

  it("does not bleed actor between two concurrent tool calls with interleaved awaits", async () => {
    async function callAs(actor: string, requestId: string) {
      await withCallerContext({ actor, actorSource: "oauth:oid", requestId }, async () => {
        await Promise.resolve();
        await new Promise((resolve) => setTimeout(resolve, Math.random() * 5));
        logToolCall({ tool: "search_users", args: {}, status: "success" });
      });
    }

    await Promise.all([callAs("actor-a", "req-a"), callAs("actor-b", "req-b")]);

    const entries = consoleErrorSpy.mock.calls.map(([line]) => JSON.parse((line as string).replace("[audit] ", "")));
    const entryA = entries.find((entry) => entry.requestId === "req-a");
    const entryB = entries.find((entry) => entry.requestId === "req-b");

    expect(entryA?.actor).toBe("actor-a");
    expect(entryB?.actor).toBe("actor-b");
  });

  it("falls back to the OS username under stdio transport when no caller context is set", () => {
    // MCP_TRANSPORT is unset in this test's env, which defaults to "stdio" -
    // this is what keeps local/Claude Desktop behavior byte-identical.
    resetServerConfigCacheForTests();

    logToolCall({ tool: "search_users", args: {}, status: "success" });

    const [line] = consoleErrorSpy.mock.calls[0] as [string];
    const entry = JSON.parse(line.replace("[audit] ", ""));

    expect(entry.actor).toBe(userInfo().username);
    expect(entry.actorSource).toBe("os-user");
  });

  it("never falls back to the OS username under http transport when no caller context is set", () => {
    process.env.MCP_TRANSPORT = "http";
    resetServerConfigCacheForTests();

    logToolCall({ tool: "search_users", args: {}, status: "success" });

    const [line] = consoleErrorSpy.mock.calls[0] as [string];
    const entry = JSON.parse(line.replace("[audit] ", ""));

    expect(entry.actor).toBe("unknown:no-caller-context");
    expect(entry.actorSource).toBe("missing");
    expect(entry.actor).not.toBe(userInfo().username);
  });

  it("truncates long string args, leaves short ones untouched, and still redacts secret-looking keys", () => {
    const longValue = "a".repeat(600);
    logToolCall({
      tool: "get_role_assignments",
      args: {
        longArg: longValue,
        shortArg: "hello",
        clientSecret: longValue,
      },
      status: "success",
    });

    const [line] = consoleErrorSpy.mock.calls[0] as [string];
    const entry = JSON.parse(line.replace("[audit] ", ""));

    expect(entry.args.longArg).toBe("a".repeat(512) + "...[truncated]");
    expect(entry.args.shortArg).toBe("hello");
    expect(entry.args.clientSecret).toBe("[REDACTED]");
  });
});
