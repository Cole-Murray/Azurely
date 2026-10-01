import { GraphError } from "@microsoft/microsoft-graph-client";

export interface ClassifiedError {
  message: string;
  /**
   * The internal error message, for the audit log only - NEVER returned to
   * the caller. Populated only by the generic `Error` fallback below, where
   * `err.message` can carry internal detail (e.g. an env var name, an
   * internal tenant lookup failure) that's fine to have in server-side logs
   * for debugging a hosted deployment, but not fine to hand to an untrusted
   * caller. Every other branch already returns a message that's deliberately
   * safe both places, so `detail` stays undefined for those.
   */
  detail?: string;
}

/**
 * /auditLogs/directoryAudits rejects (400) any activityDateTime filter older
 * than the tenant's actual audit retention window (30 days on Entra ID P1/
 * P2, 7 days on Free) - the query itself is invalid past that point, not
 * just empty, because Entra has already purged the data. Graph's error body
 * for this case reads like: "Specified argument was out of the range of
 * valid values. (Parameter 'Minimum allowed time for activityDateTime is
 * <date>')". Matched by substring on the message (case-insensitive) rather
 * than a status/code pair alone, since this specific failure has been
 * observed coming back with a generic `code: "UnknownError"` that's
 * indistinguishable from any other 400 without inspecting the message text.
 */
const RETENTION_WINDOW_EXCEEDED_PATTERN = /minimum allowed time|out of the range of valid values/i;

/**
 * Translates a thrown Graph SDK error into a message that's safe to hand
 * back to Claude - never the raw `body` verbatim, since it can echo back
 * tenant-identifying detail beyond what's needed. `err.message` (as opposed
 * to `body`) is a narrower, Microsoft-authored sentence and is surfaced
 * directly for the specific cases below where its detail is actually useful
 * to the caller.
 *
 * A 429 reaching this function at all means the shared client's RetryHandler
 * (see graph/throttling.ts) already retried up to its configured limit and
 * still got throttled - that's worth saying explicitly rather than showing
 * a generic error, since it tells the caller "try again later" instead of
 * "something is broken."
 */
export function classifyGraphError(err: unknown): ClassifiedError {
  if (err instanceof GraphError) {
    if (err.statusCode === 403) {
      return { message: "Graph denied this request - the app registration may be missing a required permission for this query." };
    }
    if (err.statusCode === 404) {
      return { message: "Graph returned not found for this request." };
    }
    if (err.statusCode === 429) {
      return { message: "Graph throttled this request and retries were exhausted - try again shortly." };
    }
    if (err.statusCode === 400 && RETENTION_WINDOW_EXCEEDED_PATTERN.test(err.message ?? "")) {
      return {
        message:
          "The requested date range is older than this tenant's audit log retention window. Microsoft Entra has already purged directory audit data beyond that window, so it can't be retrieved via Graph regardless of how the query is paged - try a shorter day window.",
      };
    }
    return { message: `Graph request failed (status ${err.statusCode}, code ${err.code ?? "unknown"}).` };
  }
  if (err instanceof Error) {
    // A bare (non-GraphError) Error reaching this point can be internal
    // config detail - e.g. "Unknown tenant: <guid>" from getTenantConfig or
    // "Missing env var ... for tenant <guid>" from getCredential - not a
    // Graph-shaped error at all. No secret values ever end up in an Error
    // message, but that's still internal configuration detail an untrusted
    // hosted caller shouldn't see verbatim. The caller gets a generic
    // message; `detail` carries the real one for the audit log so a hosted
    // deployment is still diagnosable from server-side logs.
    return { message: "An internal error occurred while handling this request.", detail: err.message };
  }
  return { message: "An unknown error occurred." };
}
