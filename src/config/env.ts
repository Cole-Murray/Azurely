import { config as loadDotenvFile } from "dotenv";
import { z } from "zod";

const envSchema = z
  .object({
    AZURE_TENANT_ID: z.string().min(1, "AZURE_TENANT_ID is required"),
    AZURE_CLIENT_ID: z.string().min(1, "AZURE_CLIENT_ID is required"),
    // Optional here, not required: when AZURE_KEY_VAULT_URL is set, main()
    // (src/index.ts) fetches this value from Key Vault and writes it into
    // process.env before any tool call happens - see the refine() below,
    // which still requires one of the two sources to be present.
    AZURE_CLIENT_SECRET: z.string().min(1).optional(),
    // Key Vault URL, e.g. https://<vault-name>.vault.azure.net/ - the
    // production-target replacement for storing AZURE_CLIENT_SECRET in
    // .env (see CLAUDE.md's Secrets section). Left unset, the app falls
    // back to reading AZURE_CLIENT_SECRET from .env exactly as before, so
    // this is additive rather than a breaking change to local dev.
    AZURE_KEY_VAULT_URL: z.string().url().optional(),
    // Second tenant, added once fabrikam.onmicrosoft.com was actually
    // available to validate a design against (see the TODO in
    // config/tenants.ts). Reuses AZURE_CLIENT_ID/AZURE_CLIENT_SECRET since
    // the app registration is multi-tenant - one app, consented into each
    // directory, not a separate registration per tenant.
    AZURE_TENANT_ID_2: z.string().min(1).optional(),
    AZURE_TENANT_DISPLAYNAME_2: z.string().min(1).optional(),
  })
  .refine((env) => Boolean(env.AZURE_TENANT_ID_2) === Boolean(env.AZURE_TENANT_DISPLAYNAME_2), {
    message: "AZURE_TENANT_ID_2 and AZURE_TENANT_DISPLAYNAME_2 must be set together",
    path: ["AZURE_TENANT_ID_2"],
  })
  .refine((env) => Boolean(env.AZURE_CLIENT_SECRET) || Boolean(env.AZURE_KEY_VAULT_URL), {
    message: "Either AZURE_CLIENT_SECRET or AZURE_KEY_VAULT_URL must be set",
    path: ["AZURE_CLIENT_SECRET"],
  });

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

/**
 * Parses and validates process.env on first call (not at module import
 * time) so that a missing variable fails loudly the first time it's
 * actually needed, rather than either crashing every test that merely
 * imports this file, or failing silently deep inside a Graph call later.
 */
export function getEnv(): Env {
  if (cached) {
    return cached;
  }

  // quiet: true - dotenv's own config() call otherwise prints a "tip" line via
  // console.log on every invocation. stdout is reserved for the MCP protocol
  // (see CLAUDE.md), so an un-silenced dependency logging to stdout at
  // startup would corrupt the stdio transport just as surely as a stray
  // console.log in our own code would.
  loadDotenvFile({ quiet: true });

  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`).join("\n");
    throw new Error(`Invalid environment configuration. See .env.example for the required variables.\n${issues}`);
  }

  cached = result.data;
  return cached;
}

/** Test-only escape hatch - clears the cache so a test can set fake env vars and re-parse. */
export function resetEnvCacheForTests(): void {
  cached = undefined;
}
