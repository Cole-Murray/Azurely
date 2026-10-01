import { z } from "zod";

/**
 * Transport/port/host configuration for hosting this MCP server over HTTP
 * (Azure Container Apps), kept deliberately separate from src/config/env.ts.
 *
 * Why a separate module instead of adding these fields to envSchema:
 * getEnv() *throws* if AZURE_TENANT_ID/AZURE_CLIENT_ID are missing or either
 * of its .refine() checks fails. If PORT lived in that same schema, then one
 * bad Azure credential var - a typo, a forgotten secret, anything - would
 * mean the process never binds a socket at all. On Azure Container Apps that
 * shows up as an opaque "container did not respond to the configured port"
 * platform error, with the actual zod validation message (the useful part)
 * buried in logs nobody thinks to check first.
 *
 * So this module's contract is narrower and deliberately can't fail on Azure
 * credential config: parse only transport/port/host/path settings, all with
 * safe defaults, so the HTTP server can always bind and answer health probes
 * *before* anything Azure-credential-shaped is validated. Azure config
 * validation (getEnv()) happens separately, later, once there's already a
 * listening socket to report the failure through.
 *
 * Note: unlike getEnv(), this module deliberately does NOT call dotenv's
 * config() itself - getEnv() already loads .env, and this module is meant to
 * stay independent of it (no import of env.ts, no shared state). In local
 * dev, if getServerConfig() is somehow called before getEnv() ever runs,
 * .env-supplied values for the vars below could be missed on that first
 * call. That's an accepted trade-off: all six vars have sensible defaults,
 * and the real deployment target (the container) supplies these directly as
 * process env vars rather than via a .env file, so the gap only matters for
 * a narrow local-dev ordering edge case, not for production.
 */
const serverConfigSchema = z.object({
  // Defaults to "stdio" so that when this var is unset - true for every
  // existing local setup today - behavior is byte-identical to before this
  // module existed. Nothing about existing .env files needs to change for
  // local/Claude Desktop usage to keep working exactly as it does now.
  MCP_TRANSPORT: z.enum(["stdio", "http"]).default("stdio"),

  // z.coerce because process.env values are always strings ("8080", not
  // 8080) - z.coerce.number() runs Number(value) before the range checks.
  // Azure Container Apps sets PORT itself to tell the container which port
  // it's probing; 8080 is only the local-dev/no-env-var default, chosen to
  // match the Dockerfile's own EXPOSE/ENV PORT default so the two agree.
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),

  // 127.0.0.1 (loopback-only) is a safe default for local dev - nothing
  // outside the machine can reach it. The container's own environment/start
  // command MUST override this to 0.0.0.0 (all interfaces), or Azure
  // Container Apps' startup probe - which connects from outside the
  // container's network namespace - can never succeed, and the revision
  // never goes healthy. This is the single most common first-deploy
  // failure for this kind of app, so it's worth over-explaining here.
  MCP_HTTP_HOST: z.string().default("127.0.0.1"),

  // Deliberately path-bearing ("/mcp"), not "/". Claude Code normalizes a
  // pathless resource URL by appending a trailing slash, and that mismatch
  // breaks Microsoft Entra's OAuth `resource` parameter matching during
  // token validation (surfaces as AADSTS9010010). Serving from a real path
  // sidesteps that class of bug entirely rather than working around it.
  MCP_HTTP_PATH: z.string().default("/mcp"),

  // Comma-separated list of hostnames the SDK's HTTP transport will accept
  // Host headers from, enabling its built-in DNS-rebinding protection.
  // Optional/undefined by default - only meaningful once actually deployed
  // behind a known hostname, so it's left unset rather than guessed at.
  MCP_ALLOWED_HOSTS: z.string().optional(),

  // Bounded retry count for the Key Vault credential warm-up performed at
  // startup (see src/config/keyVault.ts). Bounded so a persistently
  // unreachable Key Vault fails the startup sequence loudly after a fixed
  // number of attempts instead of retrying forever.
  MCP_KEYVAULT_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(5),
});

/**
 * Friendly, already-parsed shape callers consume - MCP_ALLOWED_HOSTS is
 * split into a trimmed, empty-string-filtered array here so every caller
 * doesn't have to re-implement that parsing itself.
 */
export type ServerConfig = {
  transport: "stdio" | "http";
  port: number;
  host: string;
  path: string;
  allowedHosts: string[] | undefined;
  keyVaultMaxAttempts: number;
};

let cached: ServerConfig | undefined;

/**
 * Parses and validates process.env on first call (not at module import
 * time), mirroring getEnv()'s lazy-memoized pattern. Every field in
 * serverConfigSchema has a default, so in practice this can only fail on a
 * genuinely malformed value someone set on purpose or by typo (e.g. an
 * out-of-range PORT or an unrecognized MCP_TRANSPORT) - not on a bare/normal
 * environment, and never because of Azure credential config (see the module
 * docblock above for why that separation matters).
 */
export function getServerConfig(): ServerConfig {
  if (cached) {
    return cached;
  }

  const result = serverConfigSchema.safeParse(process.env);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`).join("\n");
    throw new Error(`Invalid server configuration.\n${issues}`);
  }

  const parsed = result.data;

  // Collapses to undefined rather than [] when the var is set but contains no
  // real entries (e.g. MCP_ALLOWED_HOSTS="," or "  "). That distinction
  // matters downstream: the SDK's host-validation middleware treats an empty
  // allow-list as "permit nothing" and would reject every request, so a
  // typo'd value must degrade to "no restriction configured" (undefined)
  // rather than to a silent, total lockout that looks like a server bug.
  const parsedHosts = parsed.MCP_ALLOWED_HOSTS
    ? parsed.MCP_ALLOWED_HOSTS.split(",")
        .map((host) => host.trim())
        .filter((host) => host.length > 0)
    : undefined;
  const allowedHosts = parsedHosts && parsedHosts.length > 0 ? parsedHosts : undefined;

  cached = {
    transport: parsed.MCP_TRANSPORT,
    port: parsed.PORT,
    host: parsed.MCP_HTTP_HOST,
    path: parsed.MCP_HTTP_PATH,
    allowedHosts,
    keyVaultMaxAttempts: parsed.MCP_KEYVAULT_MAX_ATTEMPTS,
  };
  return cached;
}

/** Test-only escape hatch - clears the cache so a test can set fake env vars and re-parse. */
export function resetServerConfigCacheForTests(): void {
  cached = undefined;
}
