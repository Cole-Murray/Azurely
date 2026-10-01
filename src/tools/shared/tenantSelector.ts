import { z } from "zod";
import { getDefaultTenantId, getTenantConfig, getTenants, type TenantConfig } from "../../config/tenants";
import { AmbiguousMatchError, NotFoundError } from "./errors";

/**
 * The zod field added to every tool's inputShape so Claude can optionally
 * specify which tenant to query. Exact-match only (vs roleLookup's substring
 * matching) because silently routing a security query to the wrong tenant on
 * a loose match is a worse failure than a clean "not found" error.
 */
export const tenantSelectorField = z
  .string()
  .trim()
  .min(1)
  .optional()
  .describe(
    "Optional. Selects which configured tenant to query - matches a tenant's directory ID (GUID) or its display name (case-insensitive, exact match). Omit to use the default tenant. If a name isn't recognized, ask the user for the tenant's directory ID (GUID) rather than guessing.",
  );

/**
 * Truncates a caller-supplied string before it's echoed back inside an error
 * message. Without this, a NotFoundError's "no tenant matches X" message
 * would let a caller stuff an arbitrarily long string into `selector` and get
 * it reflected back verbatim in both the tool result and the audit log -
 * a harmless quirk on a local stdio server, but once this server is hosted
 * over HTTP that's a free log/response amplification primitive for an
 * untrusted caller. Appends an ellipsis marker so truncation is visible
 * rather than silently changing the caller's input.
 */
function truncateForMessage(value: string, max = 64): string {
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

/**
 * Resolves an optional caller-supplied selector to a TenantConfig. Mirrors
 * resolveRoleDefinition in roleLookup.ts: a tools-facing resolver above the
 * pure data layer in config/tenants.ts. Kept separate to avoid giving the
 * config layer MCP-specific error semantics.
 *
 * Resolution order:
 *  1. No selector → default tenant (getDefaultTenantId).
 *  2. Exact tenantId GUID match.
 *  3. Case-insensitive exact displayName match (ambiguous if > 1 match).
 *  4. NotFoundError - deliberately does not list the configured tenants (see
 *     the comment at the throw site below).
 */
export function resolveTenantSelector(selector?: string): TenantConfig {
  if (!selector) {
    return getTenantConfig(getDefaultTenantId());
  }

  const tenants = getTenants();

  const idMatch = tenants.find((t) => t.tenantId === selector);
  if (idMatch) return idMatch;

  const query = selector.trim().toLowerCase();
  const nameMatches = tenants.filter((t) => t.displayName.toLowerCase() === query);
  if (nameMatches.length === 1) return nameMatches[0];
  if (nameMatches.length > 1) {
    throw new AmbiguousMatchError(
      `"${truncateForMessage(selector)}" matched more than one configured tenant - use the tenant's ID (GUID) to disambiguate.`,
    );
  }

  // Deliberately does NOT list the configured tenants. This message reaches
  // the caller verbatim (runTool -> toErrorResult) and lands in the audit
  // log, and once this server is hosted that's an unauthenticated
  // tenant-enumeration oracle - at many customer tenants it would be a
  // customer-list disclosure. The selector is truncated so the error can't
  // be used to echo back arbitrary caller-supplied text.
  throw new NotFoundError(
    `No configured tenant matches "${truncateForMessage(selector)}". Specify the tenant's directory ID (GUID) or its exact display name.`,
  );
}
