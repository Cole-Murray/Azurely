# Setup

Onboarding for a colleague picking up this project: local development against
the stdio transport, and connecting to the hosted HTTP deployment. If you're
trying to understand *why* something is built the way it is, `CLAUDE.md` and
`SECURITY.md` are the deeper references — this file is about getting
something running.

## 1. What this is

An MCP (Model Context Protocol) server that lets Claude answer read-only
questions about Entra ID directory role assignments and Azure RBAC/PIM state
across one or more tenants — "who holds Global Admin," "what roles does Alex
have," "show recent role changes." It talks to Microsoft Graph and Azure
Resource Manager as its own app-only identity; see `CLAUDE.md` for the full
architecture and `SECURITY.md` for the permission model.

## 2. Prerequisites

- **Node**, the exact version pinned in `.nvmrc` (currently `22.22.3`;
  `package.json`'s `engines` field enforces `>=22.22.0 <23`). Use `nvm`/`fnm`/
  whatever you prefer to match it — a newer Node 22 patch is fine, a
  different major is not tested.
- **An Entra app registration** with the Graph application permissions and
  the Azure RBAC Reader grant listed in `SECURITY.md` §3. If you're setting
  one up from scratch, that section is the checklist to consent against; if
  one already exists for the tenant you're targeting, you just need its
  tenant ID, client ID, and client secret.
- **Azure RBAC `Reader`** assigned to that app registration's service
  principal at the target tenant's root management group, for the V3
  `get_azure_*`/`get_user_group_pim_eligibility` tools to return anything.
  The V1/V2 directory tools work without it.

## 3. Local development (stdio)

```bash
git clone <repo-url>
cd Azure-MCP
npm ci
cp .env.example .env
```

Fill in `.env` — at minimum `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, and
`AZURE_CLIENT_SECRET` for the app registration from step 2. Everything else
in `.env.example` has a comment explaining when you'd need it (a second
tenant, Key Vault instead of a plain secret, HTTP hosting).

```bash
npm run build
npm test
```

`npm test` runs the unit suite only (`jest --selectProjects unit`) — it mocks
every Graph/ARM response and never makes a live call. `npm run test:integration`
exists too, but it's gated behind `RUN_INTEGRATION_TESTS=true` and hits the
real tenant(s) in `.env`; don't run it unless you mean to.

To point Claude Desktop or Claude Code at your local build, add an entry like
this to the client's MCP config (`claude_desktop_config.json` for Desktop, or
`.mcp.json` for Claude Code):

```json
{
  "mcpServers": {
    "entra-iam-review": {
      "command": "node",
      "args": ["/absolute/path/to/Azure-MCP/dist/index.js"],
      "env": {
        "AZURE_TENANT_ID": "<tenant-guid>",
        "AZURE_CLIENT_ID": "<app-client-id>",
        "AZURE_CLIENT_SECRET": "<client-secret>"
      }
    }
  }
}
```

Leaving `MCP_TRANSPORT` unset (as above) keeps stdio behavior — this is the
default and requires no HTTP-specific configuration at all.

## 4. Running the HTTP transport locally

The same server can run as a Streamable HTTP endpoint instead of stdio. Set,
in your shell or `.env`:

```
MCP_TRANSPORT=http
PORT=3999
MCP_HTTP_HOST=127.0.0.1
```

(`127.0.0.1` is fine for a local smoke test; a real container deployment
needs `0.0.0.0` instead — see `SECURITY.md` §12 and `infra/README.md`.)

Leave `MCP_INBOUND_TENANT_ID`/`MCP_INBOUND_AUDIENCES` unset for this local
smoke test — the server falls back to serving **unauthenticated**, which
`src/http/httpServer.ts` logs explicitly (`"no inbound auth configured -
serving UNAUTHENTICATED"`) and which is only ever appropriate for this kind
of local check, never a real deployment.

```bash
npm run build
node dist/index.js
```

Then, in another terminal:

```bash
# Liveness - always 200 once the process is up, independent of credentials.
curl -i http://127.0.0.1:3999/healthz

# Readiness - 503 until credentials finish loading, then 200.
curl -i http://127.0.0.1:3999/readyz
```

To actually call the MCP endpoint, both headers below are required — this is
a genuinely non-obvious requirement of the Streamable HTTP transport and
skipping either one produces an error that doesn't look like a headers
problem at first glance:

```bash
curl -i http://127.0.0.1:3999/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke-test","version":"0.0.0"}}}'
```

**Omitting `text/event-stream` from `Accept` returns `406`.** The transport
requires the client to declare it can accept both response shapes, even for
a request that will resolve as plain JSON. **Sending a `Content-Type` other
than `application/json`** (or omitting it) **returns `415`.** Both of these
are verified behavior — see `tests/unit/http/httpServer.test.ts`'s "negative
header cases" — not guesses. If you're debugging a client integration and
get an unexpected 406/415, check these two headers before anything else.

## 5. Connecting to the hosted server

Once a deployment exists (see §7 below), a real client needs a valid Entra
access token in every request's `Authorization: Bearer <token>` header. How
you get that token differs by client.

### Claude Code

Claude Code supports a `headersHelper` — a script it runs before each
connection (and again on a `401`/`403`) whose stdout it parses as a JSON
object of headers to attach. Point it at the Azure CLI:

`.mcp.json`:
```json
{
  "mcpServers": {
    "entra-iam-review-hosted": {
      "type": "http",
      "url": "https://<your-app>.<region>.azurecontainerapps.io/mcp",
      "headersHelper": "./scripts/get-mcp-token.sh"
    }
  }
}
```

`scripts/get-mcp-token.sh`:
```bash
#!/usr/bin/env bash
set -euo pipefail
: "${MCP_API_CLIENT_ID:?Set MCP_API_CLIENT_ID to the MCP API app registration client ID}"
TOKEN=$(az account get-access-token \
  --scope "api://${MCP_API_CLIENT_ID}/.default" \
  --query accessToken -o tsv)
printf '{"Authorization":"Bearer %s"}\n' "$TOKEN"
```

Run `az login` once, first — the token this script fetches is under *your
own* Azure AD identity, not a shared service credential. That means it
carries your own MFA/Conditional Access posture, expires in about an hour,
and is automatically revoked the moment you're offboarded, with nothing
extra to rotate or clean up on the server side. Claude Code re-invokes the
helper automatically on a `401`/`403`, so an expired token self-heals on the
next call rather than requiring you to notice and re-authenticate by hand.

### Claude Desktop

Claude Desktop has no `headersHelper`, and [`mcp-remote`](https://www.npmjs.com/package/mcp-remote)
is a poor fit here: it always runs OAuth discovery against this server's
Protected Resource Metadata, which points at Entra and needs a verified
custom domain we don't have yet. Use the repo's stdio↔HTTP bridge instead
(`scripts/claude-desktop-mcp.js`) — it fetches a bearer token via Azure CLI
and forwards MCP JSON-RPC. No browser OAuth.

**Prerequisites:** Node.js, Azure CLI
([MSI recommended](https://aka.ms/installazurecliwindows)), Claude Desktop,
and a clone of this repo with `npm ci` already run.

**One-time login** (your own Entra identity — not the app's client secret):

```powershell
az login --tenant <your-tenant-id> --scope "api://<mcp-api-app-client-id>/.default"
```

**Config file location (Windows Store / MSIX Claude):**

`%LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\claude_desktop_config.json`

Add (or merge) an entry like this — replace `REPO` with the absolute path to
your clone:

```json
{
  "mcpServers": {
    "entra-iam-review-hosted": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": [
        "REPO\\scripts\\claude-desktop-mcp.js"
      ],
      "cwd": "REPO",
      "env": {
        "MCP_API_CLIENT_ID": "<mcp-api-app-client-id>",
        "MCP_TENANT_ID": "<your-tenant-id>",
        "MCP_URL": "https://<your-app>.<region>.azurecontainerapps.io/mcp"
      }
    }
  }
}
```

Fully quit Claude Desktop (tray → Quit) and reopen. In Settings → Developer,
`entra-iam-review-hosted` should show connected (not failed).

If token fetch fails under Desktop, install/reinstall the Azure CLI **MSI**
(not only a pip `az`) so the bridge can find
`C:\Program Files\Microsoft SDKs\Azure\CLI2\wbin\az.cmd`. Pip-only installs
can break when Claude Desktop's PATH prefers a different Python.

## 6. Troubleshooting

| Symptom | Cause |
|---|---|
| `401` with a `WWW-Authenticate` header | Missing, expired, or invalid bearer token. Re-run the token-fetch step (§5). |
| `403` | Token is valid but doesn't carry the required scope (`iam.read` by default) — an `InsufficientScopeError` from `src/auth/callerToken.ts`. Check the API app registration's exposed scope and that your token request asked for it. |
| `503` on `/readyz` | Credential warm-up hasn't finished or has failed. Check the `reason` field in the `/readyz` JSON body (it's a classified, human-readable string — see `classifyWarmUpError` in `src/http/httpServer.ts`), and the container logs for the matching `[http] credential warm-up ... failed` line. |
| `406` on a POST to `/mcp` | `Accept` header is missing `text/event-stream` — see §4. |
| `415` on a POST to `/mcp` | `Content-Type` isn't exactly `application/json` — see §4. |
| `AADSTS9010010` | The `resource` value in the token request doesn't match a registered Application ID URI. Often caused by a trailing-slash mismatch — this is exactly why `MCP_HTTP_PATH` defaults to `/mcp` rather than `/` (see `src/config/serverConfig.ts`'s comment on this). |
| `AADSTS70021` | Federated identity subject mismatch — this is an exact, case-sensitive string comparison Azure AD does against the federated credential's configured `subject` (e.g. `repo:Org/Repo:ref:refs/heads/main`). Check the CI federated credential setup in `infra/README.md` §8 character-by-character against the actual repo owner/name/branch. |
| Audit entry shows `actor: "unknown:no-caller-context"` | This is a bug in the auth wiring, not a legitimate "anonymous caller" state. It means a request reached a tool call with no caller context established — see `SECURITY.md` §9 for why the logger deliberately refuses to guess an actor here rather than falling back to the container's OS username. |

## 7. Deployment

See `infra/README.md` for the full runbook — provisioning, the Bicep
template, CI/CD via `.github/workflows/deploy.yml`, secret rotation, and
rollback. One thing worth stating plainly here rather than only in that
file's own status note: **the Bicep template has never been validated
against a real Azure CLI or subscription** — it was authored on a machine
without the Azure CLI installed. Treat it as documented intent, and run
`az bicep build --file main.bicep` (a pure compile check, no Azure login
needed) as the first sanity check before trusting anything else in that
runbook.
