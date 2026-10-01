import { ClientSecretCredential, type AccessToken, type GetTokenOptions, type TokenCredential } from "@azure/identity";
import { getTenantConfig } from "../config/tenants";

/**
 * Wraps ClientSecretCredential so every token fetch logs whether it
 * succeeded, without ever exposing the token itself. This is the only
 * class in the codebase that touches a raw access token - keeping that
 * narrow makes "never log secrets" easy to audit by inspection.
 */
class LoggingCredential implements TokenCredential {
  constructor(
    private readonly tenantId: string,
    private readonly inner: ClientSecretCredential,
  ) {}

  async getToken(scopes: string | string[], options?: GetTokenOptions): Promise<AccessToken | null> {
    const token = await this.inner.getToken(scopes, options);
    console.error(`[auth] token acquired: ${token ? "yes" : "no"} (tenant=${this.tenantId})`);
    return token;
  }
}

const credentialCache = new Map<string, TokenCredential>();

export function getCredential(tenantId: string): TokenCredential {
  const cached = credentialCache.get(tenantId);
  if (cached) {
    return cached;
  }

  const tenant = getTenantConfig(tenantId);
  const clientSecret = process.env[tenant.clientSecretEnvVar];
  if (!clientSecret) {
    throw new Error(`Missing env var "${tenant.clientSecretEnvVar}" for tenant ${tenantId}`);
  }

  const credential = new LoggingCredential(tenantId, new ClientSecretCredential(tenant.tenantId, tenant.clientId, clientSecret));
  credentialCache.set(tenantId, credential);
  return credential;
}

/** Test-only escape hatch - clears the cache between test cases. */
export function resetCredentialCacheForTests(): void {
  credentialCache.clear();
}
