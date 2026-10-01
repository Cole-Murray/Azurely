import type { Server } from "node:http";
import express, { type Express, type Request, type RequestHandler } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import { createServer, SERVER_NAME, SERVER_VERSION } from "../server/createServer";
import { withCallerContext } from "../audit/callerContext";
import { getEnv } from "../config/env";
import { loadClientSecretFromKeyVault } from "../config/keyVault";
import type { ServerConfig } from "../config/serverConfig";
import { createCallerTokenVerifier, loadCallerTokenOptionsFromEnv } from "../auth/callerToken";
import { callerContextFromRequest } from "./callerIdentity";
import { getReadiness, markFailed, markReady } from "./readiness";

/**
 * The Streamable HTTP transport for this MCP server (Azure Container Apps
 * hosting). Two things are exported deliberately separately:
 *
 *  - buildHttpApp(config, deps): pure app construction, no socket bound. This
 *    is what tests use (via supertest) so the whole route/middleware/auth
 *    stack can be exercised without a real port, a real Azure credential, or
 *    a real Entra token anywhere in the test run.
 *  - startHttpServer(config, buildTimestamp): the real entrypoint. Binds a
 *    socket, wires up graceful shutdown, and kicks off credential warm-up.
 *
 * Design: stateless, one McpServer + one StreamableHTTPServerTransport per
 * POST. Every one of the 12 tools is a plain request/response Graph/ARM read
 * - there are no notifications, subscriptions, sampling, or progress
 * streaming anywhere in this codebase - so there is nothing that needs a
 * session to live across requests. Statelessness also means replica count,
 * scale-to-zero, and revision rollovers are invisible to a client: Container
 * Apps' session affinity is cookie-based, and MCP clients don't keep a
 * cookie jar, so affinity was never going to be a correctness mechanism here
 * even if sessions existed.
 */

export interface HttpServerOAuthConfig {
  tenantId: string;
  requiredScope: string;
  /** MCP_CANONICAL_RESOURCE - the deployed, public URL of the MCP endpoint. */
  canonicalResource?: string;
}

export interface HttpServerDeps {
  /**
   * Configured inbound-token verifier. Omit to run with `requireBearerAuth`
   * skipped entirely - a deliberately unauthenticated configuration that
   * must only ever be used locally (see callerIdentity.ts's own warning on
   * the "no req.auth" path this produces).
   */
  verifier?: OAuthTokenVerifier;
  /**
   * OAuth metadata needed both for the RFC 9728 protected-resource document
   * and for requireBearerAuth's resourceMetadataUrl. Present whenever
   * `verifier` is; the protected-resource document is still served (with a
   * best-effort resource/authorization_servers) even when both are absent,
   * since a client must be able to read *something* to learn how (or that
   * it can't yet) authenticate.
   */
  oauth?: HttpServerOAuthConfig;
  /** Build timestamp surfaced on /healthz. Defaults to "unknown". */
  buildTimestamp?: string;
}

function jsonRpcError(code: number, message: string, data?: unknown): { jsonrpc: "2.0"; id: null; error: { code: number; message: string; data?: unknown } } {
  return { jsonrpc: "2.0", id: null, error: { code, message, data } };
}

/**
 * Builds the RFC 9728 OAuth 2.0 Protected Resource Metadata document served
 * (unauthenticated) at both well-known paths. Hand-rolled rather than using
 * the SDK's `mcpAuthMetadataRouter` - that helper also mounts
 * `/.well-known/oauth-authorization-server`, echoing authorization-server
 * metadata from this server's own origin, which is wrong here: Entra ID is
 * the real authorization server, not this process.
 */
function buildProtectedResourceMetadata(config: ServerConfig, oauth: HttpServerOAuthConfig | undefined, req: Request) {
  const resource = oauth?.canonicalResource ?? `${req.protocol}://${req.get("host") ?? `${config.host}:${config.port}`}${config.path}`;
  return {
    resource,
    authorization_servers: oauth ? [`https://login.microsoftonline.com/${oauth.tenantId}/v2.0`] : [],
    scopes_supported: oauth ? [oauth.requiredScope] : [],
    bearer_methods_supported: ["header"],
    resource_name: SERVER_NAME,
  };
}

/** Constructs the Express app. Never binds a socket - see the module docblock. */
export function buildHttpApp(config: ServerConfig, deps: HttpServerDeps = {}): Express {
  const app = express();

  // Required so `req.body` is already a parsed object by the time
  // transport.handleRequest(req, res, req.body) runs, letting the transport
  // skip re-reading the request stream itself. Safe to apply globally: the
  // transport's own Content-Type check (406/415, see below) inspects
  // headers directly, not req.body, so a non-JSON POST still gets the
  // transport's own error response regardless of what this middleware did.
  app.use(express.json());

  // ---- Liveness -----------------------------------------------------
  // Deliberately does zero I/O - no Graph, no ARM, no Key Vault. A liveness
  // probe that touches any of those turns a transient 429/network blip into
  // Container Apps concluding the replica is dead and restarting it, which
  // both loses in-flight work and burns a fresh token acquisition every
  // ~30s forever. This must answer 200 the instant the process can run JS,
  // independent of whether credential warm-up (see startHttpServer below)
  // has completed or even started.
  app.get("/healthz", (_req, res) => {
    res.status(200).json({
      status: "ok",
      version: SERVER_VERSION,
      build: deps.buildTimestamp ?? "unknown",
    });
  });

  // ---- Readiness ------------------------------------------------------
  // This is the probe that actually keeps a still-warming-up replica out of
  // rotation. Unlike /healthz, its answer legitimately depends on whether
  // credential warm-up has finished - but this handler itself still does no
  // I/O; it only reads the in-memory state startHttpServer's warm-up loop
  // maintains (src/http/readiness.ts).
  app.get("/readyz", (_req, res) => {
    const readiness = getReadiness();
    res.status(readiness.status === "ready" ? 200 : 503).json(readiness);
  });

  // ---- OAuth protected-resource metadata (RFC 9728) -------------------
  // Unauthenticated by design - a client must be able to read this before
  // it has any token at all, to learn which authorization server to go get
  // one from.
  //
  // Only mounted when inbound auth is actually configured. RFC 9728 requires
  // this document's `authorization_servers` to name at least one authorization
  // server, and the MCP spec repeats that as a MUST - so in the
  // no-auth-configured dev path there is nothing truthful to put here.
  // Serving `{"authorization_servers": []}` would be worse than serving
  // nothing: a client would fetch it, parse it successfully, find no
  // authorization server to talk to, and have no way to distinguish that from
  // a misconfigured deployment. A 404 says "this resource advertises no OAuth
  // metadata" unambiguously, which for an intentionally unauthenticated local
  // server is exactly the truth.
  if (deps.oauth) {
    const metadataHandler: RequestHandler = (req, res) => {
      res.status(200).json(buildProtectedResourceMetadata(config, deps.oauth, req));
    };
    app.get("/.well-known/oauth-protected-resource/mcp", metadataHandler);
    app.get("/.well-known/oauth-protected-resource", metadataHandler);
  }

  // resourceMetadataUrl is built once, at app-construction time, not per
  // request: requireBearerAuth is itself constructed once below and reused
  // across every POST. Preferring oauth.canonicalResource (MCP_CANONICAL_RESOURCE)
  // over anything derived from a single request's Host header keeps this
  // stable even behind a load balancer/ingress that might rewrite Host.
  const resourceMetadataUrl = deps.oauth
    ? getOAuthProtectedResourceMetadataUrl(
        new URL(deps.oauth.canonicalResource ?? `http://${config.host}:${config.port}${config.path}`),
      )
    : undefined;

  // ---- The MCP endpoint itself ----------------------------------------
  // Readiness gate runs before auth: an unready replica should say so
  // before spending any effort validating a bearer token, and a client
  // seeing 503 (rather than some auth-shaped error) knows to just retry.
  const readinessGate: RequestHandler = (_req, res, next) => {
    const readiness = getReadiness();
    if (readiness.status !== "ready") {
      res.status(503).json(jsonRpcError(-32000, "Server not ready", readiness));
      return;
    }
    next();
  };

  const postMiddleware: RequestHandler[] = [readinessGate];
  if (deps.verifier) {
    postMiddleware.push(
      requireBearerAuth({
        verifier: deps.verifier,
        requiredScopes: deps.oauth ? [deps.oauth.requiredScope] : undefined,
        // Omitting this would mean the WWW-Authenticate header on a 401 has
        // no resource_metadata parameter, and Claude (and other spec-
        // compliant clients) fall back to well-known probing on every
        // connection attempt instead of being told directly where to look.
        resourceMetadataUrl,
      }),
    );
  }

  app.post(config.path, ...postMiddleware, async (req, res) => {
    // One McpServer + one transport per request - see module docblock for
    // why this is correct (not wasteful) for a fully stateless, all-reads
    // tool set. createServer() and the caches it wires into are cheap; see
    // createServer.ts's own docblock.
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({
      // undefined, not a generator function, is what puts the transport in
      // stateless mode - no session ID is ever minted or expected back.
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    // 'close' fires after the response has been fully flushed to the
    // socket, so tearing down here cannot truncate the JSON body
    // enableJsonResponse mode resolves handleRequest's promise with.
    res.on("close", () => {
      void transport.close();
      void server.close();
    });

    await server.connect(transport);
    // withCallerContext wraps the whole synchronous dispatch into the tool
    // handler (see audit/callerContext.ts) - handleRequest's own promise is
    // what's awaited here, not something separately awaited inside the
    // callback, so caller context stays live across every Graph/ARM await
    // inside the tool call.
    await withCallerContext(callerContextFromRequest(req), () => transport.handleRequest(req, res, req.body));
  });

  // GET/DELETE on the MCP path: in stateless mode there is no standalone
  // SSE stream to open (GET) and no session to tear down (DELETE), so both
  // are rejected explicitly here rather than left for the transport
  // instance (which does not exist yet at this point - the app has none
  // between requests) to field.
  const methodNotAllowed: RequestHandler = (_req, res) => {
    res.set("Allow", "POST");
    res.status(405).json(jsonRpcError(-32000, "Method not allowed - this endpoint only accepts POST"));
  };
  app.get(config.path, methodNotAllowed);
  app.delete(config.path, methodNotAllowed);

  return app;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Turns whatever getEnv()/loadClientSecretFromKeyVault() threw into a short,
 * human-actionable string safe to put in an HTTP response body (see
 * readiness.ts's markFailed docblock on why this can never be the raw
 * error). Matched on message substrings rather than @azure/identity's own
 * error classes - this project doesn't otherwise import those types, and
 * the messages below are stable across the handful of failure modes that
 * actually occur in practice (bad RBAC grant, missing secret, DNS/network,
 * bad env config).
 */
function classifyWarmUpError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);

  if (/invalid environment configuration/i.test(message)) {
    return "config: invalid environment configuration (see .env.example for required variables)";
  }
  if (/forbidden|access denied|401|403/i.test(message)) {
    return "keyvault: access denied fetching azure-client-secret (check the managed identity's Key Vault Secrets User role)";
  }
  if (/not found|404/i.test(message)) {
    return "keyvault: azure-client-secret not found in the configured vault";
  }
  if (/getaddrinfo|enotfound|econnrefused|network|timeout|timed out/i.test(message)) {
    return "keyvault: network error reaching Key Vault (check DNS/connectivity/firewall)";
  }
  return "startup: credential warm-up failed (see server logs for detail)";
}

/**
 * Credential warm-up, run after the socket is already bound (see
 * startHttpServer). Loops up to `maxAttempts` with exponential backoff
 * (capped at 30s) calling getEnv() and, when AZURE_KEY_VAULT_URL is set,
 * loadClientSecretFromKeyVault - the same two calls src/index.ts's stdio
 * path makes synchronously before connecting a transport.
 *
 * On exhausting every attempt, this deliberately does NOT process.exit(1).
 * A crash loop under Container Apps surfaces only "Activation failed" to
 * whoever is looking at the revision, with the actual error scrolled away
 * in logs nobody thinks to check first - the exact failure mode this
 * project's README/CLAUDE.md already warns about for other silent-failure
 * cases. Staying up with markFailed() means /readyz keeps the replica out
 * of rotation (so no traffic is misrouted to a half-configured process)
 * while still answering a diagnosable 503 body plus a log line, instead of
 * disappearing into a restart loop.
 */
async function warmUpCredentials(maxAttempts: number): Promise<void> {
  const BASE_DELAY_MS = 500;
  const MAX_DELAY_MS = 30_000;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const env = getEnv();
      if (env.AZURE_KEY_VAULT_URL) {
        await loadClientSecretFromKeyVault(env.AZURE_KEY_VAULT_URL);
      }
      markReady();
      console.error(`[http] credential warm-up succeeded on attempt ${attempt}/${maxAttempts}`);
      return;
    } catch (err) {
      const reason = classifyWarmUpError(err);
      console.error(`[http] credential warm-up attempt ${attempt}/${maxAttempts} failed: ${reason}`);
      if (attempt === maxAttempts) {
        markFailed(reason, attempt);
        return;
      }
      await sleep(Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), MAX_DELAY_MS));
    }
  }
}

/**
 * The real HTTP entrypoint: binds a socket, installs graceful shutdown, then
 * kicks off credential warm-up in the background (deliberately not awaited -
 * the socket must already be listening, and /healthz/ /readyz must already
 * be answerable, before warm-up even starts).
 */
export function startHttpServer(config: ServerConfig, buildTimestamp: string): Server {
  let verifier: OAuthTokenVerifier | undefined;
  let oauth: HttpServerOAuthConfig | undefined;
  try {
    const options = loadCallerTokenOptionsFromEnv();
    verifier = createCallerTokenVerifier(options);
    oauth = {
      tenantId: options.tenantId,
      requiredScope: options.requiredScope,
      canonicalResource: options.canonicalResource,
    };
    console.error("[http] inbound caller-token auth configured: yes");
  } catch (err) {
    // Missing MCP_INBOUND_TENANT_ID/MCP_INBOUND_AUDIENCES is the expected
    // shape of this failure - loadCallerTokenOptionsFromEnv() requires both.
    // Falling back to unauthenticated here (rather than refusing to start)
    // is deliberate: it's what makes a quick local `MCP_TRANSPORT=http`
    // smoke test possible without provisioning an Entra app registration
    // first. This must never be the story for a real deployment - see
    // callerIdentity.ts's warning on the "no req.auth" path this produces.
    console.error(
      "[http] no inbound auth configured - serving UNAUTHENTICATED (dev-only; a real deployment " +
        "must set MCP_INBOUND_TENANT_ID and MCP_INBOUND_AUDIENCES):",
      err instanceof Error ? err.message : String(err),
    );
  }

  const app = buildHttpApp(config, { verifier, oauth, buildTimestamp });

  const server = app.listen(config.port, config.host, () => {
    console.error(
      `[server] Entra IAM Review MCP v${SERVER_VERSION} (build ${buildTimestamp}) listening on ` +
        `http://${config.host}:${config.port}${config.path}`,
    );
  });

  // Node registers no signal handlers of its own, and Linux does not
  // deliver SIGTERM to PID 1 (which `node` is, inside the container)
  // unless something has registered a handler for it. Without this, every
  // Container Apps revision swap/scale-down sends SIGTERM, nothing responds,
  // and the process is SIGKILLed 30s later with whatever tool calls were
  // in flight cut mid-request.
  //
  // Cannot be tested on Windows, and don't waste time trying: Windows has no
  // POSIX signals, so Git Bash's `kill -TERM` becomes TerminateProcess, which
  // is uncatchable - the process dies with exit 143 and this handler never
  // runs. Verified that's an environment limit rather than a bug here by
  // running the same test against a three-line script whose only job is to
  // catch SIGTERM: it behaves identically. This path is only exercisable on
  // Linux (the container, or CI's ubuntu runner).
  const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 10_000; // stays under Container Apps' 30s grace period
  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.error(`[server] received ${signal}, shutting down gracefully`);

    // server.close() stops accepting *new* connections but waits for
    // in-flight requests to finish on its own - bound that wait so a
    // request that never completes can't block shutdown past Container
    // Apps' own grace period.
    const forceTimer = setTimeout(() => {
      console.error("[server] graceful shutdown timed out waiting for in-flight requests, forcing exit");
      process.exit(0);
    }, GRACEFUL_SHUTDOWN_TIMEOUT_MS);
    forceTimer.unref();

    server.close(() => {
      clearTimeout(forceTimer);
      console.error("[server] all connections closed, exiting");
      process.exit(0);
    });
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  void warmUpCredentials(config.keyVaultMaxAttempts);

  return server;
}
