import { DefaultAzureCredential } from "@azure/identity";
import { SecretClient } from "@azure/keyvault-secrets";

// The one Key Vault secret this project needs: the multi-tenant app
// registration's client secret (see config/tenants.ts - both configured
// tenants reuse the same AZURE_CLIENT_ID/AZURE_CLIENT_SECRET, so one
// secret in the vault covers every tenant, same as one env var does today).
const CLIENT_SECRET_NAME = "azure-client-secret";

/**
 * Fetches the app registration's client secret from Key Vault and writes it
 * into process.env.AZURE_CLIENT_SECRET, so getCredential() (src/auth/
 * credential.ts) keeps reading process.env[tenant.clientSecretEnvVar]
 * completely unchanged - the only thing that changes is where that value
 * came from before startup finished. Must run before the first tool call
 * (see main() in src/index.ts), since that's the first place the secret is
 * actually read.
 *
 * Uses DefaultAzureCredential rather than a fixed credential type so the
 * same code works two ways with no branching: locally, it falls back to
 * your own `az login` session (AzureCliCredential); once this runs hosted
 * in Azure, it picks up a system-assigned Managed Identity instead. Either
 * way, it's your own identity's Key Vault RBAC role that's checked here -
 * not the app registration's secret, which is exactly the thing this
 * removes from .env.
 */
export async function loadClientSecretFromKeyVault(vaultUrl: string): Promise<void> {
  const client = new SecretClient(vaultUrl, new DefaultAzureCredential());
  const secret = await client.getSecret(CLIENT_SECRET_NAME);
  if (!secret.value) {
    throw new Error(`Key Vault secret "${CLIENT_SECRET_NAME}" at ${vaultUrl} has no value`);
  }
  process.env.AZURE_CLIENT_SECRET = secret.value;
  console.error("[keyvault] AZURE_CLIENT_SECRET loaded: yes");
}
