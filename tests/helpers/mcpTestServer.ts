import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export type ToolHandler = (args: Record<string, unknown>) => Promise<CallToolResult>;

/**
 * Captures the callback a registerXxx(server) function passes to
 * server.registerTool, so tests can invoke a tool directly without a real
 * stdio transport or constructing an actual McpServer instance. Every v1
 * tool's test suite needs this same capture, so it lives here once instead
 * of each test file defining its own copy.
 */
export function captureToolHandler(register: (server: McpServer) => void, toolName: string): ToolHandler {
  let handler: ToolHandler | undefined;
  const fakeServer = {
    registerTool: (name: string, _config: unknown, cb: ToolHandler) => {
      if (name === toolName) {
        handler = cb;
      }
    },
  } as unknown as McpServer;

  register(fakeServer);
  if (!handler) {
    throw new Error(`Tool "${toolName}" was never registered`);
  }
  return handler;
}
