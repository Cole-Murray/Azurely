import { resetEnvCacheForTests } from "../../../src/config/env";
import { getTenantConfig, getTenants } from "../../../src/config/tenants";

// Without this, dotenv's config() call reads the real .env file in this
// repo and fills in any var a test doesn't explicitly set (dotenv only
// populates currently-unset vars) - see tests/unit/config/env.test.ts for
// the same issue. Matters here specifically because a real second tenant
// is expected to be configured in that file.
jest.mock("dotenv");

const originalEnv = { ...process.env };

beforeEach(() => {
  resetEnvCacheForTests();
  process.env.AZURE_TENANT_ID = "tenant-123";
  process.env.AZURE_CLIENT_ID = "client-456";
  process.env.AZURE_CLIENT_SECRET = "shh";
  delete process.env.AZURE_TENANT_ID_2;
  delete process.env.AZURE_TENANT_DISPLAYNAME_2;
});

afterEach(() => {
  process.env = { ...originalEnv };
  resetEnvCacheForTests();
});

describe("getTenants", () => {
  it("builds a single-tenant array from env vars", () => {
    expect(getTenants()).toEqual([
      {
        tenantId: "tenant-123",
        displayName: "Contoso Production",
        clientId: "client-456",
        clientSecretEnvVar: "AZURE_CLIENT_SECRET",
      },
    ]);
  });

  it("appends the second tenant, reusing the primary clientId/secret, when configured", () => {
    process.env.AZURE_TENANT_ID_2 = "tenant-789";
    process.env.AZURE_TENANT_DISPLAYNAME_2 = "fabrikam";

    expect(getTenants()).toEqual([
      {
        tenantId: "tenant-123",
        displayName: "Contoso Production",
        clientId: "client-456",
        clientSecretEnvVar: "AZURE_CLIENT_SECRET",
      },
      {
        tenantId: "tenant-789",
        displayName: "fabrikam",
        clientId: "client-456",
        clientSecretEnvVar: "AZURE_CLIENT_SECRET",
      },
    ]);
  });
});

describe("getTenantConfig", () => {
  it("finds the tenant by its Entra tenant GUID", () => {
    expect(getTenantConfig("tenant-123").displayName).toBe("Contoso Production");
  });

  it("throws for an unknown tenant id", () => {
    expect(() => getTenantConfig("does-not-exist")).toThrow("Unknown tenant: does-not-exist");
  });

  it("finds the second tenant by its Entra tenant GUID once configured", () => {
    process.env.AZURE_TENANT_ID_2 = "tenant-789";
    process.env.AZURE_TENANT_DISPLAYNAME_2 = "fabrikam";

    expect(getTenantConfig("tenant-789").displayName).toBe("fabrikam");
  });
});
