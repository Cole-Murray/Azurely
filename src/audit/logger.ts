import { userInfo } from "node:os";
import { getCallerContext } from "./callerContext";
import { getServerConfig } from "../config/serverConfig";

/**
 * Structured audit log for every tool call. Written via console.error -
 * stdout is reserved for the MCP protocol, so nothing in this file may
 * ever use console.log.
 */

export type ToolCallStatus = "success" | "error" | "validation_error";

export interface ToolCallAuditEntry {
  timestamp: string;
  actor: string;
  actorSource: string;
  actorUpn?: string;
  tool: string;
  args: Record<string, unknown>;
  status: ToolCallStatus;
  errorMessage?: string;
  requestId?: string;
  clientId?: string;
}

// Belt-and-suspenders: even though tool schemas shouldn't accept secrets as
// input, redact any arg whose key looks sensitive before it ever reaches a log line.
const SECRET_KEY_PATTERN = /secret|token|password|credential/i;

// Hosted over HTTP, tool args are attacker-influenced (any MCP client can send
// arbitrary strings) and this log line ends up shipped to Azure Log
// Analytics. An unbounded string arg is a way to blow up log line size or
// bury the actually-useful fields in noise, so every string value is capped
// here regardless of key name. Only strings are touched - numbers/booleans/
// nested objects pass through unchanged, since truncation only makes sense
// for a string's length.
const MAX_ARG_STRING_LENGTH = 512;
const TRUNCATION_MARKER = "...[truncated]";

function truncateValue(value: unknown): unknown {
  if (typeof value === "string" && value.length > MAX_ARG_STRING_LENGTH) {
    return value.slice(0, MAX_ARG_STRING_LENGTH) + TRUNCATION_MARKER;
  }
  return value;
}

function stripSecrets(args: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    safe[key] = SECRET_KEY_PATTERN.test(key) ? "[REDACTED]" : truncateValue(value);
  }
  return safe;
}

function resolveActor(): { actor: string; actorSource: string; actorUpn?: string; requestId?: string; clientId?: string } {
  // Prefer the per-request caller identity threaded via AsyncLocalStorage
  // (see src/audit/callerContext.ts for why ALS was chosen over a parameter).
  const callerContext = getCallerContext();
  if (callerContext) {
    return {
      actor: callerContext.actor,
      actorSource: callerContext.actorSource,
      actorUpn: callerContext.actorUpn,
      requestId: callerContext.requestId,
      clientId: callerContext.clientId,
    };
  }

  // No caller context was established for this call. What "actor" should mean
  // here depends entirely on transport:
  const { transport } = getServerConfig();

  if (transport === "http") {
    // Hosted mode with no caller context is not "unauthenticated" in the
    // ordinary sense - it means auth wiring/middleware didn't populate one,
    // which should never happen once auth is fully wired up, but the audit
    // logger cannot assume that. Falling back to the container's OS username
    // here (as the code below does for stdio) would be actively wrong: every
    // request from every real person would be attributed to "node" or
    // "root", a plausible-looking but entirely fabricated actor in a
    // security audit log that SECURITY.md §9 claims identifies the actor -
    // and there would be no way to tell, after the fact, that it was
    // fabricated. A greppable, obviously-bogus sentinel is strictly safer:
    // it fails loudly and is trivially distinguishable from a real actor.
    return { actor: "unknown:no-caller-context", actorSource: "missing" };
  }

  // stdio: unchanged from pre-hosting behavior. There is exactly one caller
  // (whoever is running this process locally / via Claude Desktop), so the
  // OS username is still a truthful actor here - this branch exists so local
  // behavior stays byte-identical to before HTTP hosting was added.
  try {
    return { actor: userInfo().username, actorSource: "os-user" };
  } catch {
    return { actor: "unknown", actorSource: "os-user" };
  }
}

export function logToolCall(params: { tool: string; args: Record<string, unknown>; status: ToolCallStatus; errorMessage?: string }): void {
  const { actor, actorSource, actorUpn, requestId, clientId } = resolveActor();
  const entry: ToolCallAuditEntry = {
    timestamp: new Date().toISOString(),
    actor,
    actorSource,
    actorUpn,
    tool: params.tool,
    args: stripSecrets(params.args),
    status: params.status,
    errorMessage: params.errorMessage,
    requestId,
    clientId,
  };
  // console.error, not console.log: under the original stdio transport this
  // was because stdout was the MCP protocol channel and any stray write
  // there corrupted it. That specific justification no longer applies once
  // this server is hosted over HTTP - stdout isn't a protocol channel there.
  // The rule is kept anyway so the audit trail stays on a single, consistent
  // stream across both transports rather than splitting based on which mode
  // is active. Don't "fix" this back to console.log for HTTP - it's
  // intentional, not a leftover.
  console.error(`[audit] ${JSON.stringify(entry)}`);
}
