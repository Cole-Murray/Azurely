import { captureToolHandler } from "../helpers/mcpTestServer";
import { registerGetUserGroupPimEligibility } from "../../src/tools/getUserGroupPimEligibility";
import { getTenants } from "../../src/config/tenants";
import { getGraphClient } from "../../src/graph/client";

const runIfEnabled = process.env.RUN_INTEGRATION_TESTS === "true" ? describe : describe.skip;

/**
 * Proves get_user_group_pim_eligibility reaches the PIM-for-Groups endpoints
 * (PrivilegedEligibilitySchedule.Read.AzureADGroup /
 * PrivilegedAssignmentSchedule.Read.AzureADGroup - the first flagged
 * exception - and Group.Read.All - the second, see CLAUDE.md) against every
 * configured tenant, and that the best-effort ARM cross-reference doesn't
 * blow up the whole call.
 *
 * Deliberately does NOT assert groups.length > 0: no PIM-governed test group
 * has necessarily been set up in every tenant yet (CLAUDE.md/MANAGER_UPDATE
 * both call this out as a separate prerequisite from the permission grants
 * themselves). An empty groups array with isError undefined still proves the
 * permissions are live - a 403/PermissionScopeNotGranted on either Graph
 * scope is what this test is actually built to catch.
 *
 * Picks an arbitrary real user via a plain $top=1 Graph call rather than
 * hardcoding a UPN, so this doesn't bake in a dependency on one specific
 * account (or PII) existing in every tenant forever.
 */
runIfEnabled("get_user_group_pim_eligibility (integration)", () => {
  for (const tenant of getTenants()) {
    it(`reads PIM-for-Groups eligibility in ${tenant.displayName} without erroring`, async () => {
      const graphClient = getGraphClient(tenant.tenantId);
      const usersPage = await graphClient.api("/users").select("id,userPrincipalName").top(1).get();
      const sampleUser = usersPage.value?.[0];
      expect(sampleUser).toBeDefined();

      const handler = captureToolHandler(registerGetUserGroupPimEligibility, "get_user_group_pim_eligibility");
      const result = await handler({ userId: sampleUser.id, tenant: tenant.tenantId });
      const payload = JSON.parse(result.content[0].text as string);

      expect(result.isError).toBeUndefined();
      expect(Array.isArray(payload.accountsMatched)).toBe(true);
      expect(Array.isArray(payload.groups)).toBe(true);

      if (payload.azureRoleLookupUnavailable) {
        console.warn(`[integration] ${tenant.displayName}: azureRoleLookupUnavailable=true - ARM cross-reference could not run`);
      }
      // Includes the best-effort ARM cross-reference, which scans every
      // subscription - see getAzureRoleAssignments.integration.test.ts.
    }, 30_000);
  }
});
