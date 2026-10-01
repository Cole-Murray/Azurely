import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Per-request caller identity, threaded implicitly via AsyncLocalStorage (ALS)
 * rather than as an explicit parameter passed down through every tool call.
 *
 * Why ALS instead of threading a parameter through runTool:
 * The MCP SDK does hand `extra.authInfo` to every tool callback, so plumbing
 * a parameter through `runTool` (src/tools/shared/runTool.ts) into each of
 * the 12 tool files looks like the more "explicit" choice. It was rejected
 * for a specific reason worth recording: `resolveTenantSelector`
 * (src/tools/shared/tenantSelector.ts) is called *inside* each tool's body,
 * below runTool, not by runTool itself. Per-user tenant authorization will
 * need the caller identity at that point too. If the identity only lived in
 * a parameter that runTool holds, that's a 12-file signature change now
 * (threading it into runTool) and another 12-file change later (threading it
 * from runTool down into every tool body's resolveTenantSelector call). ALS
 * reaches both call sites - the audit logger today, tenant authorization
 * later - with zero signature changes anywhere, because any code running
 * anywhere on the async call stack established by withCallerContext can just
 * call getCallerContext() directly.
 *
 * Safety verified against @modelcontextprotocol/sdk 1.29.0 by reading its
 * source: the HTTP transport invokes `onmessage` *synchronously* inside
 * `handleRequest`, and `Protocol` dispatches to the registered tool handler
 * on that same synchronous call stack. That means context established with
 * `withCallerContext` around `handleRequest` is live for the entire tool
 * call, including every `await`ed Graph/ARM round trip inside it - ALS
 * follows the async continuation, not just the synchronous frame.
 *
 * Known limit: if this server ever adopts the SDK's experimental "tasks"
 * support, a task's handler can be invoked later from a queue drain instead
 * of directly from the originating request's call stack. That would run
 * outside the AsyncLocalStorage context established for the request and
 * getCallerContext() would return undefined there. This assumption must be
 * re-verified before enabling tasks.
 */

export interface CallerContext {
  /** Stable identity for the audit log - the Entra `oid` claim. NEVER a token. */
  actor: string;
  /** How `actor` was determined, e.g. "oauth:oid" | "os-user" | "anonymous". */
  actorSource: string;
  /** Human-readable, MUTABLE - display only, never for authorization decisions. */
  actorUpn?: string;
  /** OAuth client_id of the calling MCP client app, when known. */
  clientId?: string;
  /** Scopes on the caller's token - the future input to tenant authorization. */
  scopes?: string[];
  /** Correlates every audit line emitted from one HTTP request. */
  requestId: string;
}

// NEVER put an access token (or any bearer credential) on CallerContext.
// src/audit/logger.ts serializes this shape wholesale into the audit log
// line, which is written to console.error and, once hosted, shipped to
// Azure Log Analytics. A token in this object would be a token leaked into
// that log store, and SECURITY.md's "never log secrets" constraint applies
// here just as much as it does to the Graph/ARM clients themselves.

const storage = new AsyncLocalStorage<CallerContext>();

/**
 * Runs `fn` with `ctx` available to any code on its (async) call stack via
 * getCallerContext(). Returns storage.run's return value directly - fn is
 * expected to be async in real use (a tool handler awaiting Graph/ARM
 * calls), so this must return the promise, not await it here, or the
 * caller would be unable to await the underlying work itself.
 */
export function withCallerContext<T>(ctx: CallerContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/** Returns the caller context for the current async call stack, if any is set. */
export function getCallerContext(): CallerContext | undefined {
  return storage.getStore();
}
