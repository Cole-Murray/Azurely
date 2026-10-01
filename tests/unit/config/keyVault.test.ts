import { loadClientSecretFromKeyVault } from "../../../src/config/keyVault";

const getSecretMock = jest.fn();

jest.mock("@azure/identity", () => ({
  DefaultAzureCredential: jest.fn(),
}));

jest.mock("@azure/keyvault-secrets", () => ({
  SecretClient: jest.fn().mockImplementation(() => ({
    getSecret: getSecretMock,
  })),
}));

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
  getSecretMock.mockReset();
});

describe("loadClientSecretFromKeyVault", () => {
  it("writes the fetched secret value into process.env.AZURE_CLIENT_SECRET", async () => {
    delete process.env.AZURE_CLIENT_SECRET;
    getSecretMock.mockResolvedValue({ value: "secret-from-vault" });

    await loadClientSecretFromKeyVault("https://fake-vault.vault.azure.net/");

    expect(getSecretMock).toHaveBeenCalledWith("azure-client-secret");
    expect(process.env.AZURE_CLIENT_SECRET).toBe("secret-from-vault");
  });

  it("throws when the secret has no value", async () => {
    getSecretMock.mockResolvedValue({ value: undefined });

    await expect(loadClientSecretFromKeyVault("https://fake-vault.vault.azure.net/")).rejects.toThrow(
      'Key Vault secret "azure-client-secret"',
    );
  });
});
