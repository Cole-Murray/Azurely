import { getCredential, resetCredentialCacheForTests } from "../../../src/auth/credential";
import { resetEnvCacheForTests } from "../../../src/config/env";

// getCredential() -> getTenantConfig() -> getTenants() -> getEnv(), which
// calls dotenv's config(). Without mocking it, dotenv reads the real .env
// file in this repo and re-populates AZURE_CLIENT_SECRET after the test
// below deletes it, defeating the "fails safely when missing" assertion.
jest.mock("dotenv");

const originalEnv = { ...process.env };

beforeEach(() => {
  resetEnvCacheForTests();
  resetCredentialCacheForTests();
  process.env.AZURE_TENANT_ID = "11111111-1111-1111-1111-111111111111";
  process.env.AZURE_CLIENT_ID = "22222222-2222-2222-2222-222222222222";
  process.env.AZURE_CLIENT_SECRET = "fake-secret";
});

afterEach(() => {
  process.env = { ...originalEnv };
  resetEnvCacheForTests();
  resetCredentialCacheForTests();
});

describe("getCredential", () => {
  it("returns the same cached instance for repeated calls with the same tenant", () => {
    const first = getCredential(process.env.AZURE_TENANT_ID as string);
    const second = getCredential(process.env.AZURE_TENANT_ID as string);

    expect(second).toBe(first);
  });

  it("fails safely when the client secret is missing", () => {
    // In v1, AZURE_CLIENT_SECRET happens to be validated twice: once by
    // env.ts's schema (every required var must be set) and once by
    // credential.ts's own lookup of tenant.clientSecretEnvVar (which
    // matters once v2 gives each tenant a *different* secret env var name
    // that env.ts's fixed schema can't know about in advance). Here env.ts
    // throws first - this test just confirms the missing secret can't
    // silently produce a credential.
    delete process.env.AZURE_CLIENT_SECRET;

    expect(() => getCredential(process.env.AZURE_TENANT_ID as string)).toThrow("AZURE_CLIENT_SECRET");
  });

  it("throws for an unknown tenant id", () => {
    expect(() => getCredential("not-a-configured-tenant")).toThrow("Unknown tenant");
  });
});
