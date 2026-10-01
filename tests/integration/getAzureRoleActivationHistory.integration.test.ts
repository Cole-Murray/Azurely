import { captureToolHandler } from "../helpers/mcpTestServer";
import { registerGetAzureRoleActivationHistory } from "../../src/tools/getAzureRoleActivationHistory";
import { getTenants } from "../../src/config/tenants";

const runIfEnabled = process.env.RUN_INTEGRATION_TESTS === "true" ? describe : describe.skip;

/**
 * Proves get_azure_role_activation_history reaches
 * roleAssignmentScheduleRequests against every configured tenant. Unlike its
 * directory-role twin, this endpoint is covered by the plain Reader RBAC
 * grant (no ReadWrite-named permission gap on the ARM plane) - this test is
 * what actually confirms that, rather than assuming it from the docs.
 */
runIfEnabled("get_azure_role_activation_history (integration)", () => {
  for (const tenant of getTenants()) {
    it(`reads self-service PIM activation history in ${tenant.displayName} without erroring`, async () => {
      const handler = captureToolHandler(registerGetAzureRoleActivationHistory, "get_azure_role_activation_history");

      const result = await handler({ tenant: tenant.tenantId });
      const payload = JSON.parse(result.content[0].text as string);

      expect(result.isError).toBeUndefined();
      expect(Array.isArray(payload.scopesQueried)).toBe(true);
      expect(payload.scopesQueried.length).toBeGreaterThan(0);
      expect(Array.isArray(payload.activations)).toBe(true);

      if (payload.accessDeniedForSomeScopes) {
        console.warn(`[integration] ${tenant.displayName}: accessDeniedForSomeScopes=true - at least one subscription denied get_azure_role_activation_history`);
      }
      // Scans every subscription - see getAzureRoleAssignments.integration.test.ts.
    }, 30_000);
  }
});
