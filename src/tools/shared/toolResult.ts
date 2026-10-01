import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/** Wraps a tool's JSON-shaped result as the text content block Claude reads. */
export function toTextResult(payload: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

/** Wraps an error message as an isError:true result - never throw out of a tool callback. */
export function toErrorResult(message: string): CallToolResult {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}
