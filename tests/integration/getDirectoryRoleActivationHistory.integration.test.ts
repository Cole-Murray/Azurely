import { captureToolHandler } from "../helpers/mcpTestServer";
import { registerGetDirectoryRoleActivationHistory } from "../../src/tools/getDirectoryRoleActivationHistory";
import { getTenants } from "../../src/config/tenants";

const runIfEnabled = process.env.RUN_INTEGRATION_TESTS === "true" ? describe : describe.skip;

/**
 * Proves get_directory_role_activation_history reaches
 * roleAssignmentScheduleInstances against every configured tenant. This tool
 * deliberately runs on the already-granted RoleAssignmentSchedule.Read.Directory
 * permission (see CLAUDE.md's Known open issues - the ReadWrite-named
 * permission for full request detail was declined), so unlike the three
 * get_azure_* tools above, no new grant is being verified here - this test
 * exists to catch a regression in the roleAssignmentScheduleInstances
 * sourcing itself, not a permissions gap.
 */
runIfEnabled("get_directory_role_activation_history (integration)", () => {
  for (const tenant of getTenants()) {
    it(`reads directory-role PIM activation history in ${tenant.displayName} without erroring`, async () => {
      const handler = captureToolHandler(registerGetDirectoryRoleActivationHistory, "get_directory_role_activation_history");

      const result = await handler({ tenant: tenant.tenantId });
      const payload = JSON.parse(result.content[0].text as string);

      expect(result.isError).toBeUndefined();
      expect(Array.isArray(payload.activations)).toBe(true);
    }, 15_000);
  }
});
