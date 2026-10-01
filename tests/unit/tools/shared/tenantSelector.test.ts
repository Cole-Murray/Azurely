import { resetEnvCacheForTests } from "../../../../src/config/env";
import * as tenantsModule from "../../../../src/config/tenants";
import { AmbiguousMatchError, NotFoundError } from "../../../../src/tools/shared/errors";
import { resolveTenantSelector } from "../../../../src/tools/shared/tenantSelector";

const TENANT_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

const originalEnv = { ...process.env };

beforeEach(() => {
  resetEnvCacheForTests();
  process.env.AZURE_TENANT_ID = TENANT_ID;
  process.env.AZURE_CLIENT_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
  process.env.AZURE_CLIENT_SECRET = "fake-secret";
});

afterEach(() => {
  process.env = { ...originalEnv };
  resetEnvCacheForTests();
  jest.restoreAllMocks();
});

describe("resolveTenantSelector", () => {
  it("returns the default tenant when selector is omitted", () => {
    const result = resolveTenantSelector();
    expect(result.tenantId).toBe(TENANT_ID);
  });

  it("returns the default tenant when selector is undefined", () => {
    const result = resolveTenantSelector(undefined);
    expect(result.tenantId).toBe(TENANT_ID);
  });

  it("resolves by tenantId GUID (exact match)", () => {
    const result = resolveTenantSelector(TENANT_ID);
    expect(result.tenantId).toBe(TENANT_ID);
  });

  it("resolves by displayName - exact case", () => {
    const result = resolveTenantSelector("Contoso Production");
    expect(result.tenantId).toBe(TENANT_ID);
  });

  it("resolves by displayName - case-insensitive", () => {
    const result = resolveTenantSelector("CONTOSO PRODUCTION");
    expect(result.tenantId).toBe(TENANT_ID);
  });

  it("resolves by displayName - all lowercase", () => {
    const result = resolveTenantSelector("contoso production");
    expect(result.tenantId).toBe(TENANT_ID);
  });

  it("throws NotFoundError for a selector that matches no tenant by ID or name", () => {
    expect(() => resolveTenantSelector("does-not-exist")).toThrow(NotFoundError);
  });

  it("does not enumerate configured tenants in the NotFoundError message", () => {
    // Regression guard for the tenant-enumeration leak: this message reaches
    // the caller verbatim once the server is hosted, so it must never list
    // configured tenants' display names or GUIDs - only tell the caller how
    // to supply a correct selector.
    let thrown: unknown;
    try {
      resolveTenantSelector("does-not-exist");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(NotFoundError);
    const message = (thrown as NotFoundError).message;
    expect(message).not.toContain("Contoso Production");
    expect(message).not.toContain(TENANT_ID);
    expect(message).toMatch(/directory ID \(GUID\)/);
    expect(message).toMatch(/exact display name/);
  });

  it("truncates a very long selector in the NotFoundError message", () => {
    const longSelector = "x".repeat(500);
    let thrown: unknown;
    try {
      resolveTenantSelector(longSelector);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(NotFoundError);
    const message = (thrown as NotFoundError).message;
    // The full 500-char selector must not be echoed back verbatim - that
    // would make this error message a log/response amplification primitive
    // for an untrusted caller.
    expect(message).not.toContain(longSelector);
    expect(message).toContain("...");
    expect(message.length).toBeLessThan(longSelector.length);
  });

  it("throws AmbiguousMatchError when two tenants share the same displayName", () => {
    jest.spyOn(tenantsModule, "getTenants").mockReturnValue([
      { tenantId: "aaa", displayName: "Shared Name", clientId: "c1", clientSecretEnvVar: "VAR1" },
      { tenantId: "bbb", displayName: "Shared Name", clientId: "c2", clientSecretEnvVar: "VAR2" },
    ]);
    expect(() => resolveTenantSelector("Shared Name")).toThrow(AmbiguousMatchError);
  });

  it("AmbiguousMatchError message suggests using the GUID", () => {
    jest.spyOn(tenantsModule, "getTenants").mockReturnValue([
      { tenantId: "aaa", displayName: "Shared Name", clientId: "c1", clientSecretEnvVar: "VAR1" },
      { tenantId: "bbb", displayName: "Shared Name", clientId: "c2", clientSecretEnvVar: "VAR2" },
    ]);
    expect(() => resolveTenantSelector("Shared Name")).toThrow(/GUID/i);
  });

  it("does not fuzzy-match - a partial name is a NotFoundError, not a match", () => {
    // Unlike resolveRoleDefinition which uses substring matching, tenant
    // resolution is exact-only to avoid silently routing to the wrong tenant.
    expect(() => resolveTenantSelector("Contoso")).toThrow(NotFoundError);
  });
});
