import { createRemoteJWKSet, jwtVerify } from "jose";
import type { JWK, JWTPayload, JWTVerifyGetKey, KeyLike } from "jose";
import { InsufficientScopeError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { z } from "zod";

/**
 * INBOUND caller-token verification - the other half of this server's auth story.
 *
 * This module and src/auth/credential.ts must NEVER share a module or a credential:
 *   - src/auth/credential.ts is OUTBOUND: this server's own app-only identity
 *     (ClientSecretCredential / client-credentials flow), used to call Graph
 *     and ARM as itself.
 *   - src/auth/callerToken.ts (this file) is INBOUND: verifying the bearer
 *     token an MCP *client* (Claude Code, Claude Desktop, etc.) presents to
 *     this server over HTTP, proving who the human caller is.
 *
 * Those are two different security boundaries wearing similar clothes (both
 * "an Entra token"), and collapsing them into one module/credential would be
 * a serious mistake. Concretely: the MCP spec requires that a server MUST NOT
 * forward the inbound token to an upstream API. This codebase satisfies that
 * requirement *by construction*, not by discipline - the outbound path is
 * client-credentials (src/auth/credential.ts), which has no notion of an
 * inbound token to forward in the first place. Do not "improve" this later
 * into an On-Behalf-Of (OBO) flow that threads the caller's token through to
 * Graph/ARM; that would reintroduce exactly the confused-deputy risk this
 * separation exists to avoid.
 */

/**
 * Why this file pins jose to v5 rather than v6 (the version the MCP SDK
 * itself depends on):
 *
 * jose@6 is ESM-only - its package.json `exports` map has no `require`
 * condition at all. Production would actually cope, because Node 22.12+
 * can `require()` an ESM graph natively. Jest cannot: it runs modules
 * through its own registry, whose synchronous require(ESM) path is gated on
 * `vm.SourceTextModule.prototype.hasAsyncGraph`, a Node >=24.9 API. On this
 * repo's pinned Node 22 that path doesn't exist, so a static
 * `import { jwtVerify } from "jose"` makes every test importing this module
 * die with `SyntaxError: Unexpected token 'export'`.
 *
 * The workarounds were both worse than switching versions: loading jose via
 * a lazy `await import("jose")` works, but only when the whole suite runs
 * under `NODE_OPTIONS=--experimental-vm-modules`, which would mean every
 * `npm test` invocation (and CI, and Windows via cross-env) carrying an
 * experimental Node flag forever - a permanent papercut on the test suite
 * that is this project's main safety net.
 *
 * jose@5.10.0 ships a real dual build (`"require": "./dist/node/cjs/index.js"`),
 * so a plain static import works everywhere with no flags and no lazy-load
 * indirection. The API surface used here - createRemoteJWKSet, jwtVerify,
 * and generateKeyPair/SignJWT in the tests - is identical across v5 and v6.
 *
 * Accepted trade-off, recorded so it's a decision and not a drift: this is
 * one major version behind, and the SDK keeps its own nested jose@6 copy.
 * Revisit (and delete this comment) once this repo's engines field moves to
 * Node >=24.9, at which point jose@6 works under Jest with a static import
 * and there is no reason to stay on v5.
 */

/**
 * The second-argument type accepted by jose's `jwtVerify` - deliberately
 * NOT written as `Parameters<typeof jwtVerify>[1]`. jose overloads
 * `jwtVerify` (a static key vs. a `JWTVerifyGetKey` resolver function), and
 * TypeScript's `Parameters<T>` on an overloaded function only reflects the
 * *last* overload signature - confirmed by hand: `Parameters<typeof
 * jwtVerify>[1]` resolves to `JWTVerifyGetKey` alone, which then rejects a
 * plain `CryptoKey` (the exact shape tests need to pass a generated RSA
 * public key directly). Spelling out the union of both overloads' key
 * parameter types here is what actually lets `keyResolver` accept either a
 * real static key (tests) or a `createRemoteJWKSet` resolver (production).
 */
// jose@5 collapses "a static key" into the single `KeyLike` type (v6 splits it
// into CryptoKey | KeyObject); the union below is still spelled out rather
// than reduced to KeyLike alone so the JWK / raw-bytes / resolver-function
// forms stay accepted too.
type KeyResolver = KeyLike | JWK | Uint8Array | JWTVerifyGetKey;

export interface CallerTokenVerifierOptions {
  tenantId: string;
  /**
   * Accepted `aud` values. A v2 Entra access token's `aud` claim is the
   * *API's* app (client) ID GUID, not a resource URI - Microsoft's docs are
   * explicit: "In v2.0 tokens, this value is always the client ID of the
   * API." So this can't be a single hardcoded string; it has to be a
   * configured list that at minimum includes the bare app-ID GUID and the
   * `api://<guid>` form, with room for a future `https://.../mcp` App ID URI
   * once that's set up - adding one is then a config change, not a code change.
   */
  audiences: string[];
  requiredScope: string;
  /** Canonical resource identifier, surfaced as AuthInfo.resource. */
  canonicalResource?: string;
  /** Injectable key resolver. Defaults to the tenant's remote JWKS; tests pass a local key. */
  keyResolver?: KeyResolver;
}

/**
 * Builds the two issuer strings Entra can present for the same tenant.
 *
 * Every Entra app registration has a `requestedAccessTokenVersion` property
 * (defaulting to 1) that is a property of the *resource* (this API), not of
 * the client calling it - a client using the v2 authorize/token endpoints
 * does NOT by itself make the resulting access token a "v2" token if the
 * resource's manifest still says version 1. The issuer differs between the
 * two:
 *   - v1: https://sts.windows.net/{tenantId}/
 *   - v2: https://login.microsoftonline.com/{tenantId}/v2.0
 * Accepting both means flipping that single manifest property can never take
 * this server down.
 */
function buildAcceptedIssuers(tenantId: string): [string, string] {
  const v2Issuer = `https://login.microsoftonline.com/${tenantId}/v2.0`;
  const v1Issuer = `https://sts.windows.net/${tenantId}/`;
  return [v2Issuer, v1Issuer];
}

function defaultJwksUrl(tenantId: string): URL {
  return new URL(`https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`);
}

/**
 * Creates an OAuthTokenVerifier that validates an inbound caller's Entra
 * access token and maps it to the MCP SDK's AuthInfo shape.
 *
 * The JWKS resolver (whether the real remote one or an injected test key) is
 * built exactly once per verifier, not per call to verifyAccessToken -
 * createRemoteJWKSet's whole value is that it caches fetched keys and
 * handles rotation/cooldown internally, which only works if the same
 * instance is reused across calls. Constructing it here (rather than inside
 * verifyAccessToken) is what guarantees that for the whole life of the
 * server.
 *
 * When options.keyResolver is supplied it wins and no remote JWKS is ever
 * constructed - that injection is the only reason the tests can exercise
 * real RS256 signature verification with a locally generated key pair and
 * still make zero network calls.
 */
export function createCallerTokenVerifier(options: CallerTokenVerifierOptions): OAuthTokenVerifier {
  const [v2Issuer, v1Issuer] = buildAcceptedIssuers(options.tenantId);
  const keyResolver: KeyResolver = options.keyResolver ?? createRemoteJWKSet(defaultJwksUrl(options.tenantId));

  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {

      const verifyOptions = {
        issuer: [v2Issuer, v1Issuer],
        audience: options.audiences,
        // Pin the algorithm explicitly - never trust the token header's own
        // `alg` field to pick the verification algorithm. Entra signs with
        // RS256; accepting anything else here would let a token forged with
        // an unexpected/weak algorithm dictate its own verification method.
        algorithms: ["RS256"],
        // Small allowance for clock skew between this server and Entra.
        clockTolerance: 60,
      };

      let payload: JWTPayload;
      try {
        // jose's `jwtVerify` is overloaded (a static key vs. a
        // `JWTVerifyGetKey` resolver function) and TypeScript can't dispatch
        // an overload from a union-typed argument - branching on `typeof
        // keyResolver` (rather than an `any`/unchecked cast) is what narrows
        // `keyResolver` to whichever single overload actually applies.
        const result =
          typeof keyResolver === "function"
            ? await jwtVerify(token, keyResolver, verifyOptions)
            : await jwtVerify(token, keyResolver, verifyOptions);
        payload = result.payload;
      } catch (err) {
        // Deliberately not including the underlying jose error message
        // verbatim - it can echo back attacker-controlled token contents
        // (e.g. a malformed claim value). Keep the client-facing message
        // generic; anything more specific belongs in server-side logs, and
        // even there, never the token itself (see "never log secrets").
        throw new InvalidTokenError(
          `Token verification failed: ${err instanceof Error ? err.name : "unknown error"}`,
        );
      }

      // Belt-and-braces beyond the issuer check: the issuer already encodes
      // the tenant, but checking `tid` directly on the payload guards against
      // any misconfiguration in the issuer strings above, and is the specific
      // check that rejects a federated guest whose token was issued by their
      // *home* tenant while still nominally passing through this tenant's
      // sign-in surface.
      if (payload.tid !== options.tenantId) {
        throw new InvalidTokenError("Token tenant (tid) does not match the expected tenant");
      }

      // `scp` (space-delimited) is only present on delegated user tokens.
      // App-only (client-credentials) tokens carry `roles` instead and have
      // no `scp` at all. Rejecting those here is deliberate: this endpoint
      // answers on behalf of a human caller, and an app-only token has no
      // meaningful human actor to attribute an audit entry to.
      const scp = payload.scp;
      if (typeof scp !== "string" || scp.trim().length === 0) {
        throw new InvalidTokenError("Not a delegated user token");
      }
      const scopes = scp.split(" ").filter((s) => s.length > 0);

      // Present but insufficient scope is a 403 (InsufficientScopeError), not
      // a 401 (InvalidTokenError) - that distinction is what tells a client
      // it needs to go re-request a broader scope from the user, rather than
      // simply re-authenticating with the same (already-valid) token.
      if (!scopes.includes(options.requiredScope)) {
        throw new InsufficientScopeError(`Token is missing required scope "${options.requiredScope}"`);
      }

      // `oid` (object ID) is the immutable identifier for the signed-in
      // user/service principal, stable across every client application that
      // signs the same human in - and it is the same value returned as the
      // Graph user object's `id`, so an audit entry built from it joins
      // directly to the directory data this server's own tools return.
      //
      // Deliberately NOT using `sub`: `sub` is pairwise per client
      // application (Entra computes it per-app to limit cross-app
      // correlation), so Claude Code and Claude Desktop signing in the same
      // human would produce two different `sub` values for one person. `oid`
      // is the only stable cross-client identity claim.
      const oid = payload.oid;
      if (typeof oid !== "string" || oid.length === 0) {
        throw new InvalidTokenError("Token is missing the oid claim");
      }

      if (typeof payload.exp !== "number") {
        // jwtVerify already enforces exp internally (rejecting expired
        // tokens before we get here), but AuthInfo.expiresAt is REQUIRED by
        // the SDK's requireBearerAuth middleware - a token that somehow
        // verified without a numeric exp would otherwise 401 on every
        // request downstream with a confusing "Token has no expiration
        // time" error that looks nothing like the real problem.
        throw new InvalidTokenError("Token is missing the exp claim");
      }

      // preferred_username (v2) / upn (v1), and name, are MUTABLE, display-only
      // claims - a user can rename themselves in Entra. Never use them for
      // authorization decisions; oid above is the only claim that's safe for that.
      const preferredUsername = typeof payload.preferred_username === "string" ? payload.preferred_username : undefined;
      const upn = typeof payload.upn === "string" ? payload.upn : undefined;
      const name = typeof payload.name === "string" ? payload.name : undefined;
      // azp (v2) / appid (v1) identify the client application that requested
      // the token - not the signed-in user.
      const azp = typeof payload.azp === "string" ? payload.azp : undefined;
      const appid = typeof payload.appid === "string" ? payload.appid : undefined;

      const authInfo: AuthInfo = {
        token,
        clientId: azp ?? appid ?? "unknown",
        scopes,
        expiresAt: payload.exp,
        extra: {
          oid,
          upn: preferredUsername ?? upn,
          name,
          tid: payload.tid,
          tokenVersion: payload.ver,
        },
      };
      if (options.canonicalResource) {
        authInfo.resource = new URL(options.canonicalResource);
      }
      return authInfo;
    },
  };
}

const envSchema = z.object({
  MCP_INBOUND_TENANT_ID: z.string().min(1, "MCP_INBOUND_TENANT_ID is required"),
  MCP_INBOUND_AUDIENCES: z
    .string()
    .min(1, "MCP_INBOUND_AUDIENCES is required")
    .transform((raw) =>
      raw
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    )
    .refine((arr) => arr.length > 0, {
      message: "MCP_INBOUND_AUDIENCES must contain at least one non-empty, comma-separated audience",
    }),
  MCP_REQUIRED_SCOPE: z.string().min(1).default("iam.read"),
  MCP_CANONICAL_RESOURCE: z.string().url().optional(),
});

/**
 * Reads this verifier's configuration from process.env.
 *
 * Deliberately NOT folded into src/config/env.ts: that schema's getEnv()
 * throws whenever the OUTBOUND (Graph/ARM) client-credentials config is
 * incomplete, which runs on every invocation of this server today (stdio
 * mode). These MCP_INBOUND_* variables are only meaningful once HTTP mode
 * exists and a caller-token verifier is actually wired up - keeping them in
 * a separate, separately-invoked loader means stdio mode is never forced to
 * have HTTP-mode env vars set just to boot.
 */
export function loadCallerTokenOptionsFromEnv(): CallerTokenVerifierOptions {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`).join("\n");
    throw new Error(
      `Invalid inbound caller-token configuration. Set MCP_INBOUND_TENANT_ID and MCP_INBOUND_AUDIENCES ` +
        `(comma-separated: the API's app-ID GUID and/or its api://<guid> form) before starting HTTP mode.\n${issues}`,
    );
  }

  return {
    tenantId: result.data.MCP_INBOUND_TENANT_ID,
    audiences: result.data.MCP_INBOUND_AUDIENCES,
    requiredScope: result.data.MCP_REQUIRED_SCOPE,
    canonicalResource: result.data.MCP_CANONICAL_RESOURCE,
  };
}
