import { getEnv, resetEnvCacheForTests } from "../../../src/config/env";

// Without this, dotenv's config() call reads the real .env file in this repo
// (present for local/manual runs) and re-populates any var a test deletes,
// since dotenv only fills in currently-unset vars rather than overriding -
// silently defeating every "missing var" test below.
jest.mock("dotenv");

const REQUIRED_VARS = ["AZURE_TENANT_ID", "AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET"] as const;
const originalEnv = { ...process.env };

function setFakeEnv(): void {
  process.env.AZURE_TENANT_ID = "fake-tenant-id";
  process.env.AZURE_CLIENT_ID = "fake-client-id";
  process.env.AZURE_CLIENT_SECRET = "fake-client-secret";
}

beforeEach(() => {
  resetEnvCacheForTests();
});

afterEach(() => {
  process.env = { ...originalEnv };
  resetEnvCacheForTests();
});

describe("getEnv", () => {
  it("returns parsed values when all required vars are set", () => {
    setFakeEnv();

    const env = getEnv();

    expect(env).toEqual({
      AZURE_TENANT_ID: "fake-tenant-id",
      AZURE_CLIENT_ID: "fake-client-id",
      AZURE_CLIENT_SECRET: "fake-client-secret",
    });
  });

  it("caches the result across calls instead of re-parsing", () => {
    setFakeEnv();

    const first = getEnv();
    process.env.AZURE_TENANT_ID = "changed-after-first-call";
    const second = getEnv();

    expect(second).toBe(first);
    expect(second.AZURE_TENANT_ID).toBe("fake-tenant-id");
  });

  it.each(REQUIRED_VARS)("throws a descriptive error when %s is missing", (missingVar) => {
    setFakeEnv();
    delete process.env[missingVar];

    expect(() => getEnv()).toThrow(missingVar);
  });

  it("leaves the second tenant fields undefined when neither is set", () => {
    setFakeEnv();

    const env = getEnv();

    expect(env.AZURE_TENANT_ID_2).toBeUndefined();
    expect(env.AZURE_TENANT_DISPLAYNAME_2).toBeUndefined();
  });

  it("returns the second tenant fields when both are set", () => {
    setFakeEnv();
    process.env.AZURE_TENANT_ID_2 = "second-tenant-id";
    process.env.AZURE_TENANT_DISPLAYNAME_2 = "fabrikam";

    const env = getEnv();

    expect(env.AZURE_TENANT_ID_2).toBe("second-tenant-id");
    expect(env.AZURE_TENANT_DISPLAYNAME_2).toBe("fabrikam");
  });

  it("throws when AZURE_TENANT_ID_2 is set without AZURE_TENANT_DISPLAYNAME_2", () => {
    setFakeEnv();
    process.env.AZURE_TENANT_ID_2 = "second-tenant-id";

    expect(() => getEnv()).toThrow("AZURE_TENANT_ID_2 and AZURE_TENANT_DISPLAYNAME_2 must be set together");
  });

  it("throws when AZURE_TENANT_DISPLAYNAME_2 is set without AZURE_TENANT_ID_2", () => {
    setFakeEnv();
    process.env.AZURE_TENANT_DISPLAYNAME_2 = "fabrikam";

    expect(() => getEnv()).toThrow("AZURE_TENANT_ID_2 and AZURE_TENANT_DISPLAYNAME_2 must be set together");
  });

  it("accepts AZURE_KEY_VAULT_URL in place of AZURE_CLIENT_SECRET", () => {
    process.env.AZURE_TENANT_ID = "fake-tenant-id";
    process.env.AZURE_CLIENT_ID = "fake-client-id";
    delete process.env.AZURE_CLIENT_SECRET;
    process.env.AZURE_KEY_VAULT_URL = "https://fake-vault.vault.azure.net/";

    const env = getEnv();

    expect(env.AZURE_CLIENT_SECRET).toBeUndefined();
    expect(env.AZURE_KEY_VAULT_URL).toBe("https://fake-vault.vault.azure.net/");
  });

  it("throws when neither AZURE_CLIENT_SECRET nor AZURE_KEY_VAULT_URL is set", () => {
    process.env.AZURE_TENANT_ID = "fake-tenant-id";
    process.env.AZURE_CLIENT_ID = "fake-client-id";
    delete process.env.AZURE_CLIENT_SECRET;
    delete process.env.AZURE_KEY_VAULT_URL;

    expect(() => getEnv()).toThrow("Either AZURE_CLIENT_SECRET or AZURE_KEY_VAULT_URL must be set");
  });
});
