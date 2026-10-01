import { SignJWT, generateKeyPair } from "jose";
import type { KeyLike } from "jose";
import { InsufficientScopeError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { createCallerTokenVerifier, loadCallerTokenOptionsFromEnv } from "../../../src/auth/callerToken";

// Every RS256 key pair, signature, and claim below is real jose - nothing in
// this file is mocked. The verifier's injectable `keyResolver` is what keeps
// it offline: passing a locally generated public key means createRemoteJWKSet
// is never constructed, so no test ever reaches the network.
//
// This is a plain static import because src/auth/callerToken.ts pins jose to
// v5, which ships a CJS build. jose@6 is ESM-only and would need
// NODE_OPTIONS=--experimental-vm-modules on Node 22 - see that file's header
// for why v5 was chosen instead.

const TENANT_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_TENANT_ID = "99999999-9999-9999-9999-999999999999";
const AUDIENCE_GUID = "22222222-2222-2222-2222-222222222222";
const V2_ISSUER = `https://login.microsoftonline.com/${TENANT_ID}/v2.0`;
const V1_ISSUER = `https://sts.windows.net/${TENANT_ID}/`;

let publicKey: KeyLike;
let privateKey: KeyLike;
let otherPublicKey: KeyLike;

beforeAll(async () => {
  const keyPair = await generateKeyPair("RS256");
  publicKey = keyPair.publicKey;
  privateKey = keyPair.privateKey;
  const otherKeyPair = await generateKeyPair("RS256");
  otherPublicKey = otherKeyPair.publicKey;
});

function baseVerifierOptions(overrides: Partial<Parameters<typeof createCallerTokenVerifier>[0]> = {}) {
  return {
    tenantId: TENANT_ID,
    audiences: [AUDIENCE_GUID],
    requiredScope: "iam.read",
    keyResolver: publicKey,
    ...overrides,
  };
}

interface SignOptions {
  issuer?: string;
  audience?: string;
  tid?: string;
  oid?: string | undefined;
  scp?: string;
  roles?: string[];
  azp?: string;
  appid?: string;
  preferred_username?: string;
  upn?: string;
  name?: string;
  ver?: string;
  expiresIn?: string;
  signWithKey?: KeyLike | Uint8Array;
  alg?: string;
}

async function signToken(opts: SignOptions = {}): Promise<string> {
  const {
    issuer = V2_ISSUER,
    audience = AUDIENCE_GUID,
    tid = TENANT_ID,
    roles,
    appid,
    preferred_username,
    upn,
    name,
    ver,
    expiresIn = "1h",
    signWithKey = privateKey,
    alg = "RS256",
  } = opts;
  // oid/scp/azp deliberately do NOT use destructuring defaults: several
  // tests pass `{ oid: undefined }` (etc.) specifically to force that claim
  // OFF the token entirely (e.g. simulating a v1 token with no azp, or an
  // app-only token with no oid). A destructuring default re-applies for an
  // explicitly-`undefined` value just as much as for an absent key, which
  // would silently put the claim back - so "was the key present at all in
  // `opts`" (not "is its value undefined") is what decides whether to fall
  // back to the default.
  const oid = "oid" in opts ? opts.oid : "user-oid-123";
  const scp = "scp" in opts ? opts.scp : "iam.read";
  const azp = "azp" in opts ? opts.azp : "client-guid-abc";

  const claims: Record<string, unknown> = { tid };
  if (oid !== undefined) claims.oid = oid;
  if (scp !== undefined) claims.scp = scp;
  if (roles !== undefined) claims.roles = roles;
  if (azp !== undefined) claims.azp = azp;
  if (appid !== undefined) claims.appid = appid;
  if (preferred_username !== undefined) claims.preferred_username = preferred_username;
  if (upn !== undefined) claims.upn = upn;
  if (name !== undefined) claims.name = name;
  if (ver !== undefined) claims.ver = ver;

  return new SignJWT(claims)
    .setProtectedHeader({ alg })
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(signWithKey);
}

describe("createCallerTokenVerifier", () => {
  it("accepts a valid v2 token and maps every AuthInfo field correctly", async () => {
    const verifier = createCallerTokenVerifier(
      baseVerifierOptions({ canonicalResource: "https://mcp.example.com/mcp" }),
    );
    const token = await signToken({
      azp: "client-guid-abc",
      preferred_username: "alex.morgan@contoso.example",
      name: "Alex Morgan",
      ver: "2.0",
      oid: "user-oid-123",
    });

    const authInfo = await verifier.verifyAccessToken(token);

    expect(authInfo.token).toBe(token);
    expect(authInfo.clientId).toBe("client-guid-abc");
    expect(authInfo.scopes).toEqual(["iam.read"]);
    // Gotcha 1: expiresAt is mandatory and MUST be a number, or the SDK's
    // requireBearerAuth middleware 401s every request regardless of validity.
    expect(typeof authInfo.expiresAt).toBe("number");
    expect(Number.isNaN(authInfo.expiresAt)).toBe(false);
    expect(authInfo.resource?.toString()).toBe("https://mcp.example.com/mcp");
    expect(authInfo.extra).toMatchObject({
      oid: "user-oid-123",
      upn: "alex.morgan@contoso.example",
      name: "Alex Morgan",
      tid: TENANT_ID,
      tokenVersion: "2.0",
    });
  });

  it("accepts a valid v1-issuer token and picks up appid/upn (gotcha 3)", async () => {
    const verifier = createCallerTokenVerifier(baseVerifierOptions());
    const token = await signToken({
      issuer: V1_ISSUER,
      azp: undefined,
      appid: "v1-client-guid",
      upn: "alex.morgan@contoso.example",
      ver: "1.0",
    });

    const authInfo = await verifier.verifyAccessToken(token);

    expect(authInfo.clientId).toBe("v1-client-guid");
    expect(authInfo.extra?.upn).toBe("alex.morgan@contoso.example");
    expect(authInfo.extra?.tokenVersion).toBe("1.0");
    expect(typeof authInfo.expiresAt).toBe("number");
  });

  it("accepts a token whose aud is the bare app-ID GUID when configured (gotcha 2)", async () => {
    const verifier = createCallerTokenVerifier(baseVerifierOptions({ audiences: [AUDIENCE_GUID] }));
    const token = await signToken({ audience: AUDIENCE_GUID });

    await expect(verifier.verifyAccessToken(token)).resolves.toBeDefined();
  });

  it("rejects a token with an aud not in the configured audiences", async () => {
    const verifier = createCallerTokenVerifier(baseVerifierOptions({ audiences: [AUDIENCE_GUID] }));
    const token = await signToken({ audience: "some-other-guid" });

    await expect(verifier.verifyAccessToken(token)).rejects.toThrow(InvalidTokenError);
  });

  it("rejects a token from an issuer that is neither the configured v1 nor v2 issuer", async () => {
    const verifier = createCallerTokenVerifier(baseVerifierOptions());
    const token = await signToken({ issuer: "https://evil.example.com/not-entra" });

    await expect(verifier.verifyAccessToken(token)).rejects.toThrow(InvalidTokenError);
  });

  it("rejects a token whose tid does not match the configured tenant", async () => {
    const verifier = createCallerTokenVerifier(baseVerifierOptions());
    // Signed with the right issuer/audience but a mismatched tid claim -
    // this is the belt-and-braces check that catches a federated guest's
    // home-tenant token that otherwise looks structurally fine.
    const token = await signToken({ tid: OTHER_TENANT_ID });

    await expect(verifier.verifyAccessToken(token)).rejects.toThrow(InvalidTokenError);
  });

  it("rejects an expired token", async () => {
    const verifier = createCallerTokenVerifier(baseVerifierOptions());
    const token = await signToken({ expiresIn: "-1h" });

    await expect(verifier.verifyAccessToken(token)).rejects.toThrow(InvalidTokenError);
  });

  it("rejects an app-only token shape (roles, no scp)", async () => {
    const verifier = createCallerTokenVerifier(baseVerifierOptions());
    const token = await signToken({ scp: undefined, roles: ["SomeAppRole.All"] });

    await expect(verifier.verifyAccessToken(token)).rejects.toThrow(InvalidTokenError);
    await expect(verifier.verifyAccessToken(token)).rejects.toThrow(/delegated/i);
  });

  it("throws InsufficientScopeError specifically when scp is present but lacks the required scope", async () => {
    const verifier = createCallerTokenVerifier(baseVerifierOptions({ requiredScope: "iam.read" }));
    const token = await signToken({ scp: "some.other.scope" });

    await expect(verifier.verifyAccessToken(token)).rejects.toThrow(InsufficientScopeError);
  });

  it("rejects a token missing the oid claim", async () => {
    const verifier = createCallerTokenVerifier(baseVerifierOptions());
    const token = await signToken({ oid: undefined });

    await expect(verifier.verifyAccessToken(token)).rejects.toThrow(InvalidTokenError);
  });

  it("rejects a token signed by a different key", async () => {
    const verifier = createCallerTokenVerifier(baseVerifierOptions({ keyResolver: otherPublicKey }));
    const token = await signToken();

    await expect(verifier.verifyAccessToken(token)).rejects.toThrow(InvalidTokenError);
  });

  it("rejects an HS256-signed token even with a matching audience/issuer (algorithms pin)", async () => {
    const verifier = createCallerTokenVerifier(baseVerifierOptions());
    const secret = new TextEncoder().encode("a-sufficiently-long-shared-secret-value");
    const token = await signToken({ alg: "HS256", signWithKey: secret });

    await expect(verifier.verifyAccessToken(token)).rejects.toThrow(InvalidTokenError);
  });
});

describe("loadCallerTokenOptionsFromEnv", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("loads a valid configuration from env, defaulting the scope to iam.read", () => {
    process.env.MCP_INBOUND_TENANT_ID = TENANT_ID;
    process.env.MCP_INBOUND_AUDIENCES = ` ${AUDIENCE_GUID} , api://${AUDIENCE_GUID} `;
    delete process.env.MCP_REQUIRED_SCOPE;
    delete process.env.MCP_CANONICAL_RESOURCE;

    const options = loadCallerTokenOptionsFromEnv();

    expect(options.tenantId).toBe(TENANT_ID);
    expect(options.audiences).toEqual([AUDIENCE_GUID, `api://${AUDIENCE_GUID}`]);
    expect(options.requiredScope).toBe("iam.read");
    expect(options.canonicalResource).toBeUndefined();
  });

  it("throws a clear error when MCP_INBOUND_TENANT_ID is missing", () => {
    delete process.env.MCP_INBOUND_TENANT_ID;
    process.env.MCP_INBOUND_AUDIENCES = AUDIENCE_GUID;

    expect(() => loadCallerTokenOptionsFromEnv()).toThrow(/MCP_INBOUND_TENANT_ID/);
  });

  it("throws when MCP_INBOUND_AUDIENCES contains no usable entries", () => {
    process.env.MCP_INBOUND_TENANT_ID = TENANT_ID;
    process.env.MCP_INBOUND_AUDIENCES = ",";

    expect(() => loadCallerTokenOptionsFromEnv()).toThrow();
  });
});
