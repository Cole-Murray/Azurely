import { isRestError } from "@azure/core-rest-pipeline";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { logToolCall } from "../../audit/logger";
import { classifyArmError } from "../../arm/armErrors";
import { AmbiguousMatchError, NotFoundError, ToolInputError } from "./errors";
import { classifyGraphError } from "./graphErrors";
import { toErrorResult, toTextResult } from "./toolResult";

/**
 * Every registerXxx tool callback must run its logic through this wrapper.
 * It guarantees three things every tool needs and shouldn't have to repeat:
 *  1. An audit log entry on every call, success or failure (CLAUDE.md
 *     requirement) - written from exactly one place so no tool can forget it.
 *  2. No exception ever escapes a tool callback. This is a long-lived stdio
 *     server - an uncaught throw here would be a bug in one query taking
 *     down every other tool's ability to run, so every failure mode is
 *     converted into a resolved isError:true result instead.
 *  3. A consistent audit "status": ToolInputError/NotFoundError/
 *     AmbiguousMatchError are all caller-input problems and log as
 *     "validation_error"; anything else (including Graph errors) logs as
 *     "error".
 *
 * Note: the SDK validates a tool's `inputSchema` *before* this callback
 * ever runs, so trivial per-field violations (wrong type, out-of-range
 * number) are rejected by the SDK itself and never reach here - only
 * cross-field rules that a flat zod raw shape can't express (checked
 * manually inside each tool with a real z.object(...).refine(...)) end up
 * as a ToolInputError that this function logs. That's a deliberate trade-off:
 * inputSchema gives Claude an auto-advertised, typed tool signature for free,
 * at the cost of the audit log not seeing the most trivial malformed-input
 * cases. Revisit only if a complete audit trail of every rejected call turns
 * out to be a hard requirement.
 */
export async function runTool<T>(toolName: string, rawArgs: Record<string, unknown>, fn: () => Promise<T>): Promise<CallToolResult> {
  try {
    const result = await fn();
    logToolCall({ tool: toolName, args: rawArgs, status: "success" });
    return toTextResult(result);
  } catch (err) {
    if (err instanceof ToolInputError || err instanceof NotFoundError || err instanceof AmbiguousMatchError) {
      logToolCall({ tool: toolName, args: rawArgs, status: "validation_error", errorMessage: err.message });
      return toErrorResult(err.message);
    }

    // ARM (management.azure.com, @azure/arm-*) and Graph throw distinct error
    // types on failure (RestError vs GraphError) - isRestError checked first
    // since it's the newer (V3) plane; everything else, including every
    // pre-existing Graph tool's error, falls through to classifyGraphError
    // completely unchanged.
    // `detail`, when present, is the real internal error message (see
    // ClassifiedError/ClassifiedArmError's docblocks) - it's deliberately
    // asymmetric: the audit log gets `detail ?? message` so a hosted
    // deployment is still diagnosable from server-side logs, while the
    // caller only ever gets the generic-safe `message` so internal
    // configuration detail (env var names, tenant lookup internals, etc.)
    // never reaches an untrusted caller.
    const { message, detail } = isRestError(err) ? classifyArmError(err) : classifyGraphError(err);
    logToolCall({ tool: toolName, args: rawArgs, status: "error", errorMessage: detail ?? message });
    return toErrorResult(message);
  }
}
