import { getEnv } from "./env";

export interface TenantConfig {
  /** Entra directory (tenant) GUID - the primary key every downstream function looks up by. */
  tenantId: string;
  /** Human-readable label used in logs, never in Graph calls. */
  displayName: string;
  /** App registration's Application (client) ID for this tenant. */
  clientId: string;
  /** Name of the env var holding this tenant's client secret (not the secret itself). */
  clientSecretEnvVar: string;
}

// TODO(multi-tenant-config): now sources exactly two tenants from 5 flat
// env vars, validated against fabrikam.onmicrosoft.com as the first
// real second tenant. Both entries reuse AZURE_CLIENT_ID/CLIENT_SECRET
// because the app registration is multi-tenant - one app consented into
// each directory, not a separate registration per tenant. That reuse
// assumption still needs re-checking if a tenant ever requires its own
// app registration instead. This still does NOT scale to many tenants -
// flat env vars per tenant was fine for 2, not for dozens. Key Vault is
// CLAUDE.md's stated production target for secrets, but a config array
// here would still need a registry of tenantId/displayName/clientId per
// tenant from somewhere. Do not build that registry speculatively - wait
// until a third tenant (or one needing its own app registration) is
// actually available, then design against real constraints instead of
// guesses. Everything else (getTenantConfig, getDefaultTenantId,
// tools/shared/tenantSelector.ts) is already written so that swapping
// this function's implementation is the only change needed when that
// day comes.
export function getTenants(): TenantConfig[] {
  const env = getEnv();
  const tenants: TenantConfig[] = [
    {
      tenantId: env.AZURE_TENANT_ID,
      displayName: "Contoso Production",
      clientId: env.AZURE_CLIENT_ID,
      clientSecretEnvVar: "AZURE_CLIENT_SECRET",
    },
  ];

  if (env.AZURE_TENANT_ID_2 && env.AZURE_TENANT_DISPLAYNAME_2) {
    tenants.push({
      tenantId: env.AZURE_TENANT_ID_2,
      displayName: env.AZURE_TENANT_DISPLAYNAME_2,
      clientId: env.AZURE_CLIENT_ID,
      clientSecretEnvVar: "AZURE_CLIENT_SECRET",
    });
  }

  return tenants;
}

export function getTenantConfig(tenantId: string): TenantConfig {
  const tenant = getTenants().find((t) => t.tenantId === tenantId);
  if (!tenant) {
    throw new Error(`Unknown tenant: ${tenantId}`);
  }
  return tenant;
}

/**
 * v1 has exactly one tenant, so every tool resolves it through this single
 * function rather than each independently indexing getTenants()[0]. That's
 * the point of the seam: when v2 adds real multi-tenant selection, this is
 * the one place that changes - no tool call site needs to know.
 */
export function getDefaultTenantId(): string {
  return getTenants()[0].tenantId;
}
