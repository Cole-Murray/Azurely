/**
 * Process-wide readiness state for the HTTP transport.
 *
 * Why this exists as a tiny state machine rather than a boolean: Container
 * Apps' readiness probe (GET /readyz, see src/http/httpServer.ts) needs to
 * distinguish three states, not two - "still warming up credentials"
 * (starting), "safe to route traffic to" (ready), and "warm-up exhausted its
 * retries and gave up" (failed). A plain boolean can't express the third
 * state, which matters: /readyz staying 503 forever with a *reason* attached
 * is how a stuck replica gets diagnosed from the probe response alone,
 * instead of needing to go dig through logs first.
 *
 * This module is deliberately the only thing that touches this state -
 * httpServer.ts's credential warm-up loop calls markReady()/markFailed(),
 * and the /readyz handler calls getReadiness(). Nothing here calls Graph,
 * ARM, or Key Vault itself; it just holds whatever the warm-up loop reports.
 */

export type ReadinessState =
  | { status: "starting" }
  | { status: "ready" }
  | { status: "failed"; reason: string; attempts: number };

let state: ReadinessState = { status: "starting" };

/** Current readiness state. Safe to call from a request handler - no I/O. */
export function getReadiness(): ReadinessState {
  return state;
}

/** Marks the process ready to receive traffic. Called once warm-up succeeds. */
export function markReady(): void {
  state = { status: "ready" };
}

/**
 * Marks warm-up as having exhausted its retries.
 *
 * `reason` MUST be a classified, human-actionable string - never a
 * stringified error object. This value is served verbatim in the /readyz
 * response body, and an @azure/identity or Graph/ARM error can carry request
 * detail (URLs, header values, sometimes token metadata) that must never
 * reach an HTTP response. Callers are responsible for classifying the
 * underlying error into a short, safe message before calling this - e.g.
 * "keyvault: access denied fetching azure-client-secret (check the managed
 * identity's Key Vault Secrets User role)".
 */
export function markFailed(reason: string, attempts: number): void {
  state = { status: "failed", reason, attempts };
}

/** Test-only escape hatch - resets to the initial "starting" state. */
export function resetReadinessForTests(): void {
  state = { status: "starting" };
}
