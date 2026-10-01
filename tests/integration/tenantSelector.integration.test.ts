import { captureToolHandler } from "../helpers/mcpTestServer";
import { registerSearchDirectoryRoles } from "../../src/tools/searchDirectoryRoles";
import { getEnv } from "../../src/config/env";

const runIfEnabled = process.env.RUN_INTEGRATION_TESTS === "true" ? describe : describe.skip;

/**
 * Smoke test for the second tenant added in tenants.ts/env.ts: proves
 * resolveTenantSelector actually reaches fabrikam.onmicrosoft.com over
 * real Graph, both by GUID and by display name, and that a bogus selector
 * still fails closed with zero Graph calls. Uses search_directory_roles
 * because it only touches role definitions (RoleManagement.Read.Directory,
 * no user PII) - the smallest-blast-radius tool to hit a brand-new tenant
 * with the first time.
 */
runIfEnabled("tenant selector against a real second tenant (integration)", () => {
  it("resolves the second tenant by its display name", async () => {
    const env = getEnv();
    const handler = captureToolHandler(registerSearchDirectoryRoles, "search_directory_roles");

    const result = await handler({ tenant: env.AZURE_TENANT_DISPLAYNAME_2 });
    const payload = JSON.parse(result.content[0].text as string);

    expect(result.isError).toBeUndefined();
    expect(Array.isArray(payload.matches)).toBe(true);
    expect(payload.matches.length).toBeGreaterThan(0);
  });

  it("resolves the second tenant by its GUID", async () => {
    const env = getEnv();
    const handler = captureToolHandler(registerSearchDirectoryRoles, "search_directory_roles");

    const result = await handler({ tenant: env.AZURE_TENANT_ID_2 });
    const payload = JSON.parse(result.content[0].text as string);

    expect(result.isError).toBeUndefined();
    expect(Array.isArray(payload.matches)).toBe(true);
    expect(payload.matches.length).toBeGreaterThan(0);
  });

  it("fails closed for a tenant selector that matches nothing", async () => {
    const handler = captureToolHandler(registerSearchDirectoryRoles, "search_directory_roles");

    const result = await handler({ tenant: "does-not-exist-tenant" });

    expect(result.isError).toBe(true);
  });
});
