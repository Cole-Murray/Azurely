import { captureToolHandler } from "../helpers/mcpTestServer";
import { registerGetAzurePimAssignments } from "../../src/tools/getAzurePimAssignments";
import { getTenants } from "../../src/config/tenants";

const runIfEnabled = process.env.RUN_INTEGRATION_TESTS === "true" ? describe : describe.skip;

/**
 * Proves get_azure_pim_assignments reaches both the roleAssignmentSchedule-
 * Instances and roleEligibilityScheduleInstances endpoints against every
 * configured tenant. Same "no explicit scope" reasoning as
 * getAzureRoleAssignments.integration.test.ts - the default scan-everything
 * path is what needs proving, not one hand-picked known-good scope.
 */
runIfEnabled("get_azure_pim_assignments (integration)", () => {
  for (const tenant of getTenants()) {
    it(`reads active + eligible Azure PIM state in ${tenant.displayName} without erroring`, async () => {
      const handler = captureToolHandler(registerGetAzurePimAssignments, "get_azure_pim_assignments");

      const result = await handler({ tenant: tenant.tenantId });
      const payload = JSON.parse(result.content[0].text as string);

      expect(result.isError).toBeUndefined();
      expect(Array.isArray(payload.scopesQueried)).toBe(true);
      expect(payload.scopesQueried.length).toBeGreaterThan(0);
      expect(Array.isArray(payload.assignments)).toBe(true);

      // Same known, tracked gap as getAzureRoleAssignments - see that file's
      // comment. Both PIM legs query the same scopes, so this can also
      // surface on the same subscription.
      if (payload.accessDeniedForSomeScopes) {
        console.warn(`[integration] ${tenant.displayName}: accessDeniedForSomeScopes=true - at least one subscription denied get_azure_pim_assignments`);
      }
      // Two full scans (active + eligible) across every subscription - see
      // getAzureRoleAssignments.integration.test.ts for why this needs more
      // than jest's 5s default. Observed to occasionally exceed 30s against
      // a tenant with ~18 subscriptions (likely Graph/ARM throttling
      // retry-after delays on top of the raw per-subscription round-trips),
      // so this one runs with extra headroom rather than the other
      // single-scan ARM tools' 30s.
    }, 60_000);
  }
});
