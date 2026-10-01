import { randomUUID } from "node:crypto";
import type { Request } from "express";
import type { CallerContext } from "../audit/callerContext";

/**
 * Builds the per-request CallerContext (src/audit/callerContext.ts) from an
 * Express request, for the HTTP transport. This is the HTTP-side equivalent
 * of the implicit "whoever is running this process locally" identity stdio
 * mode uses - see src/audit/logger.ts's resolveActor() for that stdio path.
 *
 * `req.auth` is populated by the SDK's `requireBearerAuth` middleware
 * (@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js) on a
 * successful token verification, before this function ever runs - so by the
 * time callerContextFromRequest is called, the token itself has already been
 * validated. This function only maps the resulting AuthInfo onto
 * CallerContext; it does no verification of its own.
 */
export function callerContextFromRequest(req: Request): CallerContext {
  // Correlates every audit line emitted from this one HTTP request/tool call,
  // independent of whether the caller is authenticated.
  const requestId = randomUUID();

  const auth = req.auth;
  if (auth) {
    // `oid` (object ID) is the stable, immutable identity claim - see
    // src/auth/callerToken.ts's own comment on why `oid` over `sub`. Falling
    // back to clientId (the calling application, not the human) only covers
    // the theoretical case where a verifier populated AuthInfo without an
    // oid in `extra` at all; createCallerTokenVerifier itself always sets it.
    const oid = typeof auth.extra?.oid === "string" ? auth.extra.oid : undefined;
    const upn = typeof auth.extra?.upn === "string" ? auth.extra.upn : undefined;

    return {
      actor: oid ?? auth.clientId,
      actorSource: "oauth:oid",
      actorUpn: upn,
      clientId: auth.clientId,
      scopes: auth.scopes,
      requestId,
      // NEVER copy auth.token onto CallerContext - see callerContext.ts's
      // own warning: this shape is serialized wholesale into the audit log.
    };
  }

  // No req.auth means requireBearerAuth was never wired up for this route -
  // i.e. no verifier is configured. This path exists only for a deliberately
  // unauthenticated local/dev HTTP configuration (running MCP_TRANSPORT=http
  // without MCP_INBOUND_TENANT_ID/MCP_INBOUND_AUDIENCES set) and must never
  // be reachable in a real deployment, where a verifier is always configured
  // and requireBearerAuth rejects any request before it gets here.
  return {
    actor: "anonymous",
    actorSource: "anonymous",
    requestId,
  };
}
