// stdout is reserved for the MCP protocol - every log line in this project
// must go through console.error, never console.log (see CLAUDE.md). This
// still holds true under the HTTP transport added below: stdout stops being
// a protocol channel once requests arrive over HTTP instead of stdio, but
// the rule is kept anyway so the audit trail stays on one consistent stream
// across both transports rather than splitting based on which mode is
// active (see src/audit/logger.ts's own note making the same call).

import { statSync } from "node:fs";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { getEnv } from "./config/env";
import { loadClientSecretFromKeyVault } from "./config/keyVault";
import { createServer, SERVER_VERSION } from "./server/createServer";
import { getServerConfig } from "./config/serverConfig";
import { startHttpServer } from "./http/httpServer";

/**
 * Best-effort build timestamp: the mtime of this compiled module
 * (dist/index.js). Logged at startup so a stale deployment - the exact
 * failure mode behind the "role changes capped / eligible roles missing"
 * bug report, where the client ran a dist/ built before the fixes - is
 * visible in the client logs instead of being silently guessed at. Wrapped
 * in try/catch so a stat failure never blocks server startup.
 */
function getBuildTimestamp(): string {
  try {
    // __filename (available in this project's CommonJS output) points at the
    // compiled dist/index.js, whose mtime is the build time.
    return statSync(__filename).mtime.toISOString();
  } catch {
    return "unknown";
  }
}

/**
 * stdio path: fail fast. Unchanged by the addition of HTTP hosting below.
 *
 * An interactive local client (Claude Desktop, a terminal MCP inspector) is
 * better served by a hard startup error than by a server that comes up
 * looking fine and then fails the first tool call - there's no probe/log
 * pipeline on the other end to diagnose a deferred failure from, just a
 * human staring at a client that "isn't working." So credential loading
 * happens synchronously, before the transport ever connects, exactly as it
 * always has.
 */
async function runStdio(): Promise<void> {
  const server = createServer();

  // Must happen before server.connect() - this is the last point before
  // tool calls can arrive, and getCredential() (src/auth/credential.ts)
  // reads process.env.AZURE_CLIENT_SECRET directly on first use per tenant.
  const env = getEnv();
  if (env.AZURE_KEY_VAULT_URL) {
    await loadClientSecretFromKeyVault(env.AZURE_KEY_VAULT_URL);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[server] Entra IAM Review MCP v${SERVER_VERSION} (build ${getBuildTimestamp()}) connected via stdio`);
}

/**
 * HTTP path: bind first, diagnose over HTTP instead of crash-looping.
 *
 * The asymmetry with runStdio() above is deliberate, not an oversight: a
 * hosted replica has no human watching a terminal at the moment it starts,
 * and no interactive session to fail loudly *into*. On Azure Container Apps
 * specifically, a process that throws before binding a port just shows up as
 * an opaque "container did not respond" / crash-loop in the platform's own
 * UI, with whatever the real error was scrolled out of view in logs nobody
 * is looking at yet. Binding the socket first means /healthz and /readyz are
 * answerable immediately, and a slow or failed Azure credential warm-up
 * (see src/http/httpServer.ts's warmUpCredentials) shows up as a diagnosable
 * 503 body plus a log line instead of the process disappearing.
 */
async function main(): Promise<void> {
  const config = getServerConfig();
  if (config.transport === "stdio") {
    await runStdio();
    return;
  }

  startHttpServer(config, getBuildTimestamp());
}

main().catch((error: unknown) => {
  console.error("[server] fatal error during startup:", error);
  process.exit(1);
});
