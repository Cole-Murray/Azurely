import type { GraphRequest } from "@microsoft/microsoft-graph-client";

/**
 * Graph requires this header (and, for $search/advanced $filter, a matching
 * .count(true)) whenever a query uses "advanced query capabilities" - things
 * like `startswith`/`or` combinations in $filter, or the /beta transitive
 * role assignment endpoints. Without it Graph returns a 400 asking for
 * exactly this. Centralized here so the header string is spelled correctly
 * in exactly one place instead of copy-pasted into every tool that needs it.
 */
export function withEventualConsistency(request: GraphRequest): GraphRequest {
  return request.header("ConsistencyLevel", "eventual");
}
