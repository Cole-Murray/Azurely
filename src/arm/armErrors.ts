import { isRestError } from "@azure/core-rest-pipeline";

export interface ClassifiedArmError {
  message: string;
  /**
   * The internal error message, for the audit log only - NEVER returned to
   * the caller. Populated only by the generic `Error` fallback below (a
   * non-RestError reaching this classifier isn't ARM-shaped at all and can
   * carry internal config detail, same reasoning as graphErrors.ts's
   * ClassifiedError.detail). Every RestError branch above already returns a
   * message that's deliberately safe to hand back, so `detail` stays
   * undefined for those.
   */
  detail?: string;
  /**
   * True specifically for a 403 - the shape every ARM tool's degrade-gracefully
   * path (see CLAUDE.md / the V3 plan) checks before falling back to an
   * `*Unavailable` flag instead of failing the whole call. Kept separate from
   * `message` so callers don't have to string-match to tell "access not yet
   * granted" apart from any other failure.
   */
  isAccessDenied: boolean;
}

/**
 * True for the two distinct shapes Azure uses to deny an ARM scope query:
 * a plain 403 (Reader not granted here at all), and - confirmed against a
 * real subscription while investigating get_azure_pim_assignments - a 400
 * with code "InsufficientPermissions" that Azure's PIM schedule-instance
 * endpoints (roleAssignmentScheduleInstances / roleEligibilityScheduleInstances)
 * return instead of a 403 when the caller only holds Reader and asks for
 * every principal's schedule at a scope rather than just their own
 * ($filter=asTarget()). Shared by queryEachScope's per-scope degrade path
 * (scopeResolver.ts) and classifyArmError below so both agree on what counts
 * as "denied here" instead of duplicating the check.
 */
export function isArmScopeAccessDenied(err: unknown): boolean {
  if (!isRestError(err)) {
    return false;
  }
  return err.statusCode === 403 || (err.statusCode === 400 && err.code === "InsufficientPermissions");
}

/**
 * The ARM (management.azure.com) sibling of tools/shared/graphErrors.ts's
 * classifyGraphError. ARM's generated clients (@azure/arm-*) throw RestError
 * from @azure/core-rest-pipeline on any non-2xx response - never the Graph
 * SDK's GraphError - so this is a distinct classifier, not a shared one.
 *
 * The 403 case is worth a dedicated message: the most likely cause isn't a
 * missing app registration permission (ARM app-only auth needs none - see
 * CLAUDE.md) but the Reader role not yet being granted to the app's service
 * principal at the tenant's root management group. Saying that explicitly
 * turns "some opaque Azure error" into an actionable next step.
 */
export function classifyArmError(err: unknown): ClassifiedArmError {
  if (isRestError(err)) {
    if (err.statusCode === 403) {
      return {
        message:
          "Azure Resource Manager denied this request - the app's service principal likely hasn't been granted the Reader role (or higher) at this tenant's root management group yet. See CLAUDE.md's Azure RBAC Reader grant requirement.",
        isAccessDenied: true,
      };
    }
    if (err.statusCode === 400 && err.code === "InsufficientPermissions") {
      return {
        message:
          "Azure Resource Manager rejected this as insufficient-permission, not a missing Reader grant - Azure requires more than Reader to list every principal's PIM schedule at this scope (Reader alone can only list its own via $filter=asTarget()). This scope's PIM data can't be read without a broader role grant here.",
        isAccessDenied: true,
      };
    }
    if (err.statusCode === 404) {
      return { message: "Azure Resource Manager returned not found for this request.", isAccessDenied: false };
    }
    if (err.statusCode === 429) {
      return {
        message: "Azure Resource Manager throttled this request and retries were exhausted - try again shortly.",
        isAccessDenied: false,
      };
    }
    return {
      message: `Azure Resource Manager request failed (status ${err.statusCode ?? "unknown"}, code ${err.code ?? "unknown"}).`,
      isAccessDenied: false,
    };
  }
  if (err instanceof Error) {
    // Same reasoning as classifyGraphError's fallback: a bare Error reaching
    // this point (not a RestError) is likely internal config detail rather
    // than an ARM response at all - return a generic message to the caller
    // and keep the real one in `detail` for the audit log only.
    return { message: "An internal error occurred while handling this request.", detail: err.message, isAccessDenied: false };
  }
  return { message: "An unknown error occurred while querying Azure Resource Manager.", isAccessDenied: false };
}
