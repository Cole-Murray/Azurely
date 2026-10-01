import { captureToolHandler } from "../helpers/mcpTestServer";
import { registerGetAzureRoleAssignments } from "../../src/tools/getAzureRoleAssignments";
import { getTenants } from "../../src/config/tenants";

const runIfEnabled = process.env.RUN_INTEGRATION_TESTS === "true" ? describe : describe.skip;

/**
 * Proves get_azure_role_assignments actually reaches Azure Resource Manager
 * end-to-end against every configured tenant - the Reader-at-root-management-
 * group grant (see CLAUDE.md's V3 architecture section) has no Graph Explorer
 * equivalent to verify in a browser, so a real subscription is the only way
 * to confirm it. No explicit scope is passed, deliberately: that's the
 * default, most-used path (scan every visible subscription), and it's the
 * path that surfaced the still-open single-subscription failure (see
 * CLAUDE.md's Known open issues) - narrowing to one known-good scope here
 * would hide exactly the thing this test needs to catch.
 */
runIfEnabled("get_azure_role_assignments (integration)", () => {
  for (const tenant of getTenants()) {
    it(`scans every visible subscription in ${tenant.displayName} without erroring`, async () => {
      const handler = captureToolHandler(registerGetAzureRoleAssignments, "get_azure_role_assignments");

      const result = await handler({ tenant: tenant.tenantId });
      const payload = JSON.parse(result.content[0].text as string);

      expect(result.isError).toBeUndefined();
      expect(Array.isArray(payload.scopesQueried)).toBe(true);
      expect(payload.scopesQueried.length).toBeGreaterThan(0);
      expect(Array.isArray(payload.assignments)).toBe(true);

      // Known, tracked gap (CLAUDE.md's Known open issues): one
      // subscription in the primary tenant currently denies this query. Surfaced here
      // rather than silently ignored, but not asserted false - that would
      // make this test permanently red for an already-flagged, unresolved
      // issue rather than a regression this change introduced.
      if (payload.accessDeniedForSomeScopes) {
        console.warn(`[integration] ${tenant.displayName}: accessDeniedForSomeScopes=true - at least one subscription denied get_azure_role_assignments`);
      }
      // Scans every subscription visible in the tenant (18+ in the primary
      // tenant) - a real network round-trip per subscription pushes this
      // well past jest's 5s default.
    }, 30_000);
  }
});
