# Entra IAM Review MCP

## Who's building this

Cole Murray — computer engineering student at UIUC. Targeting software engineering / embedded / autonomous vehicles as a career. This project is a resume highlight, so **explain concepts as you go, not just code** — assume familiarity with Git, REST APIs, and general programming, but not with MCP, Entra ID, Graph API, or OAuth app-only auth specifically. When a design choice is non-obvious, say why before implementing it.

## What this is

An MCP (Model Context Protocol) server that lets Claude answer questions about **Entra ID (Azure AD) directory role assignments** in a target Entra tenant — read-only. Example: "who holds Global Admin," "what roles does Alex have," "show recent role changes." It's the bridge between Claude and Microsoft Graph.

Full spec: `entra_iam_mcp_dev_plan.md`. Setup walkthrough: `SETUP.md`. Read both before making structural decisions — they encode the agreed scope and sequencing.

## Current status

**V1 complete, V2 complete, V3 in active development.** All 7 v1 tools (`search_users`, `search_directory_roles`, `get_role_assignments`, `get_user_directory_roles`, `explain_directory_role`, `get_recent_role_changes`, `assess_role_risk`) are implemented and tested against a real tenant. V2 multi-tenant support (tenant selector plumbing, second-tenant integration test coverage, ambiguous-user aggregation, 30-day role-change pagination) is done. V3 adds five tools spanning a second API plane, Azure Resource Manager (ARM) — Azure RBAC role assignments and PIM for Azure resources — plus a first-class directory-role PIM activation-history tool and a PIM-for-Groups eligibility tool: `get_azure_role_assignments`, `get_azure_pim_assignments`, `get_azure_role_activation_history`, `get_directory_role_activation_history`, `get_user_group_pim_eligibility`.

**Also, on the `remote-hosting` branch:** the server now supports a hosted Streamable HTTP transport (Azure Container Apps) with per-user Entra authentication, alongside the original stdio transport. stdio remains the default (`MCP_TRANSPORT` unset) and its behavior is unchanged — HTTP is opt-in, not a replacement. See `SECURITY.md` §12 and `SETUP.md` for the auth model and how to connect.

## Known open issues

First two discovered 2026-07-27/28, third discovered 2026-07-31, all by driving V3 tools against a real production-scale tenant. Recorded here deliberately, not just fixed and moved past, so none get lost — the first is a permanent scope decision that needs to stay visible; the second is an unresolved root cause that a code-level workaround must not be mistaken for "solved"; the third is a naming/behavior mismatch now called out in the tool's own description, not a data-quality bug.

**`get_directory_role_activation_history` no longer reports justification/ticket/requestor/approval status — permanent, by decision, not a bug.** It originally sourced from `roleManagement/directory/roleAssignmentScheduleRequests`, which carries that request-transaction detail, but Graph gates that endpoint behind `RoleAssignmentSchedule.ReadWrite.Directory` even for a plain `GET` (see "Key learnings from V3 implementation" below and `SECURITY.md` §5). The project decision is that no write-named permission will be requested, ever — the read-only sibling (`RoleAssignmentSchedule.Read.Directory`, already granted) has to be enough. The tool now sources from `roleAssignmentScheduleInstances` instead (via `graph/pimSchedules.ts`'s `fetchAllRoleAssignmentScheduleInstances`, the same endpoint `get_user_directory_roles` already uses), covered by that already-granted permission. **What this costs:** the tool can report who activated which directory role and when it started/ended, but never why — no justification, no ticket reference, no approver. The fuller implementation is still in the repo, unused, at `src/graph/pimScheduleRequests.ts`, in case this decision is ever revisited.

**`get_directory_role_activation_history` is a current-state snapshot, not a historical log, despite its name — permanent limitation of its data source, now documented in the tool description.** Found by comparing its output against `get_recent_role_changes` for the same window and seeing wildly different results (one entry vs. 250+) for the same tenant. Root cause: `roleAssignmentScheduleInstances` (see the previous entry) is a current-state endpoint — `fetchAllRoleAssignmentScheduleInstances` applies no date filter because there's nothing to filter on. The instant an activation's `endDateTime` passes, Graph drops it from this endpoint entirely; it is never retained anywhere Graph will hand back. So this tool can only ever report activations still inside their active window at the moment you call it — it cannot show anything that already expired, whether that was a minute ago or a month ago. `get_recent_role_changes` (sourced from the real `/auditLogs/directoryAudits` audit trail, retained for the tenant's actual 30-day window) is the tool that covers genuine history. Nothing to fix code-wise — Graph doesn't expose a historical version of this endpoint — but the tool's description was rewritten to say this explicitly rather than implying "history" it can't deliver.

**One Azure subscription fails ARM PIM schedule-instance queries — root cause not understood, needs portal-side investigation.** One subscription in the primary tenant returns `400 InsufficientPermissions` on `roleEligibilityScheduleInstances`/`roleAssignmentScheduleInstances` `listForScope` calls (message: `"The requestor ... does not have permissions for this request. Please use $filter=asTarget() to filter on the requestor's assignments."`) — even though the app's service principal holds the same Reader grant, inherited the same way from the root management group, that succeeds cleanly on the tenant's other subscriptions. `queryEachScope` (`src/arm/scopeResolver.ts`) correctly degrades this one scope now (`get_azure_pim_assignments` returns `accessDeniedForSomeScopes: true` and the other subscriptions' data, instead of failing the whole call) — **but that graceful handling is a fix for the symptom (the whole call dying), not the underlying question of why this one subscription behaves differently.** Candidate theories, none yet confirmed: Azure Lighthouse delegation on that subscription, a deny assignment, or a different management-group inheritance path than the others. Don't read the graceful degradation as "resolved" — it needs someone to actually look at that subscription's RBAC/delegation configuration in the Azure portal.

## Scope

**V1 (complete):** Seven read-only tools for single-tenant Entra directory role review.

**V2 (complete):** Multi-tenant support for many customer tenants. Users select a tenant via `tenantId` parameter on all tools. Auth and Graph calls are parameterized by tenant; tenant config lives in `src/config/tenants.ts` as an array (currently two entries: a primary tenant and a secondary `fabrikam` test tenant). Integration test coverage includes tenant-selection flows.

**V3 (in progress):** Azure Resource Manager (ARM) plane — a genuinely separate permission system from Graph (Azure RBAC role assignments, not Graph consent). Adds:
  - `get_azure_role_assignments` — standing Azure RBAC (Owner/Contributor/Reader/etc.) at a subscription or resource group.
  - `get_azure_pim_assignments` — Azure-resource PIM eligible/active state at a scope.
  - `get_azure_role_activation_history` — Azure-resource PIM activation timeline (who activated, when, justification/ticket).
  - `get_directory_role_activation_history` — the directory-role twin of the above, promoted to a first-class tool (previously only inferrable from `get_recent_role_changes`' audit entries). Reports who activated which role and when, not why — see "Known open issues" above for why justification/ticket/requestor detail isn't included.
  - `get_user_group_pim_eligibility` — PIM-for-Groups eligibility/active membership for a user, cross-referenced (best effort) with the Azure RBAC role the group itself holds. The only tool spanning both the Graph and ARM planes in one call.

  See "Architecture for Azure RBAC/PIM (V3)" below for how this coexists with the V1/V2 Graph tooling without disrupting it.

**Out of scope (v4+):** Any write/activation operations (still read-only by construction — this includes PIM-for-Groups *management*, not just reads), PIM-for-Groups membership browsing outside the PIM-eligibility context, migrating the existing Graph tooling to the typed Graph SDK (deliberately declined during V3 — see the V3 plan), and the many-tenant config/Key Vault registry (still waiting on real constraints, not built speculatively). **Per-user tenant authorization** (restricting which tenants a given authenticated caller may query, as opposed to today's per-call tenant *data isolation* — see `SECURITY.md` §7) is identified but not built. `resolveTenantSelector` (`src/tools/shared/tenantSelector.ts`) is the seam where it plugs in — it's already called inside each tool body with the caller identity reachable via `getCallerContext()` (see the ALS note above), so no new plumbing is needed to add the check. Whatever that check ends up being, it must **fail closed**: an error resolving or evaluating a caller's tenant authorization must deny the request, never silently fall through to "allow."

## Non-negotiable constraints

- **Read-only by construction.** No `POST`/`PATCH`/`DELETE` Graph *or* ARM calls anywhere. This isn't a style preference — it's the security boundary that makes building against a production tenant (and, as of V3, real Azure subscriptions) acceptable. On the ARM plane this is enforced by only ever calling `@azure/arm-*` SDK read operations (`.list*`, `.get`), never `.create*`/`.delete*`/`.beginDelete*`.
- **Least privilege.** Keep to this explicit set of Graph *application* permissions and the one ARM role grant, each earning its place. See `SECURITY.md` for the complete permission table (grant status, what each one unlocks, and the two deliberate, flagged exceptions below):
  - `RoleManagement.Read.Directory` — role definitions and role assignments.
  - `User.Read.All` — resolve user principals to display names.
  - `AuditLog.Read.All` — directory audit history (recent role changes).
  - `RoleAssignmentSchedule.Read.Directory` — PIM active role assignments (`roleAssignmentSchedules`/`roleAssignmentScheduleInstances` — current-state endpoints only).
  - `RoleEligibilitySchedule.Read.Directory` — PIM eligible role assignments.
  - `Application.Read.All` — resolve *service principal / application* holders of a role to human-readable names (Graph returns only a GUID for these under the narrower scopes above). Scoped to reading service principals, not writing them.
  - `RoleAssignmentSchedule.ReadWrite.Directory` (V3, `get_directory_role_activation_history`) — **a deliberate, flagged exception.** Graph gates the *request-transaction* detail (justification, ticket, requestor, approval status) on `roleAssignmentScheduleRequests` behind this ReadWrite-named permission even for GET — the plain-read `RoleAssignmentSchedule.Read.Directory` above only covers the thinner current-state endpoints, with no request detail. Code stays 100% GET-only; This was originally requested for full fidelity, then reversed — see "Known open issues" above; the tool now runs on the read-only permission instead.
  - `PrivilegedEligibilitySchedule.Read.AzureADGroup` / `PrivilegedAssignmentSchedule.Read.AzureADGroup` (V3, `get_user_group_pim_eligibility`) — PIM-for-Groups eligible/active membership reads.
  - `Group.Read.All` (V3, `get_user_group_pim_eligibility`) — **a second deliberate, flagged exception**, reversing the constraint two lines below. Needed to resolve a PIM-governed group's `groupId` to its display name (PIM-for-Groups objects return only a GUID); this project ran V1/V2 specifically *without* it.
  - **Azure RBAC `Reader`** (V3, all three `get_azure_*` tools) — granted to the app's service principal at each tenant's root management group, not a Graph permission at all. See "Architecture for Azure RBAC/PIM (V3)" below.

  Don't reach for `Directory.Read.All` or other broader scopes to work around a hard query — solve it within this set, or flag the limitation to the maintainer. Note that group holders' display names on the *directory* plane (`get_role_assignments`) still aren't resolved by default even though `Group.Read.All` now exists in the grant — that was a deliberate scope decision for V3 (see the V3 plan's "Out of scope"), not an oversight.
- **Never log secrets.** Client secret and access tokens never hit `console.error`, files, or exceptions. Log "token acquired: yes/no," never the token.
- **stdout is reserved for the MCP protocol.** Always use `console.error` for debug/log output, never `console.log`. A stray `console.log` corrupts the stdio transport and looks like a confusing parse error on the client side — this is the #1 beginner MCP mistake per SETUP.md. **This rule now has two justifications, not one.** Under stdio, the original reason still applies exactly as before. Under HTTP, that specific reason no longer holds — stdout isn't a protocol channel there, so a stray `console.log` wouldn't corrupt anything. The rule is kept anyway, deliberately, so the audit trail stays on one consistent stream (`console.error`) across both transports instead of splitting behavior based on which mode is active. This note exists so a future contributor who correctly notices "the original reason doesn't apply under HTTP" doesn't "fix" this back to `console.log` for the HTTP path — that would be a regression, not a cleanup.
- **Validate all tool inputs with `zod`.** Malformed input should never reach a Graph call.
- **Structured audit logging** on every tool call: timestamp, actor, tool name, arguments (secrets stripped), result status.
- **Handle Graph throttling (429).** Respect `Retry-After` on all Graph calls, not just the happy path.

## Architecture for multi-tenant (V2)

**Tenant config** lives in `src/config/tenants.ts` as `getTenants()` (array of TenantConfig objects). Currently sources:
  - Contoso Production (from `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`)
  - fabrikam.onmicrosoft.com (from `AZURE_TENANT_ID_2`, `AZURE_TENANT_DISPLAYNAME_2`, same app reg secrets)

**Tenant selection:** Every MCP tool accepts an optional `tenantSelector` field (string, matches tenant ID or display name, case-insensitive for names). Resolves via `resolveTenantSelector()` in `src/tools/shared/tenantSelector.ts`. If omitted, uses `getDefaultTenantId()` (currently first entry).

**Auth & Graph calls:** All parameterized by `tenantId`. The credential flows through `src/auth/credential.ts` and Graph client in `src/graph/client.ts` — both take `tenantId` as a parameter.

**Known limitation:** Flat env vars (AZURE_TENANT_ID, AZURE_TENANT_ID_2) don't scale to many tenants. Key Vault is the stated production target, but config infrastructure is already designed to swap this function's implementation without touching downstream code. Do not build a speculative registry — wait until a third tenant is available, then design against real constraints.

## Architecture for Azure RBAC/PIM (V3)

**Two API planes, not one.** Everything in V1/V2 talks to Microsoft Graph (`graph.microsoft.com`). V3 adds Azure Resource Manager (ARM, `management.azure.com`) as a second, independent plane — a different permission model entirely (an Azure RBAC role assignment to the app's service principal, not a Graph application permission), a different token audience, and a different SDK family (`@azure/arm-*` instead of `@microsoft/microsoft-graph-client`). The two planes never mix inside one Graph or ARM call; `get_user_group_pim_eligibility` is the one tool that queries both, sequentially, for one answer.

**ARM client** — `src/arm/client.ts`: per-tenant (and, for scoped clients, per-subscription) cached `SubscriptionClient` / `AuthorizationManagementClient` / `ResourceManagementClient` instances, the ARM sibling of `src/graph/client.ts`. Reuses `getCredential(tenantId)` from `src/auth/credential.ts` **completely unchanged** — that credential was already audience-neutral (`getToken(scopes, ...)` takes the scope as a parameter), and the `@azure/arm-*` clients request `https://management.azure.com/.default` from it automatically. No new auth code was needed for V3's plane.

**Scope resolution** — `src/arm/scopeResolver.ts`: `resolveAzureScopes(tenantId, explicitScope?)` auto-discovers every subscription the app's service principal can see (`GET /subscriptions` equivalent) when no explicit scope is given, or narrows to one subscription/resource-group scope when the caller passes one. `queryEachScope` tolerates a 403 on any individual scope (Reader not yet granted there) without failing the whole call — `assertNotAllScopesDenied` only throws when *every* queried scope was denied, so a partial Reader rollout across subscriptions degrades gracefully rather than erroring outright.

**Role definitions** — `src/arm/roleDefinitions.ts` + `src/cache/azureRoleDefinitionsCache.ts`: caches Azure RBAC role definitions (Owner/Contributor/Reader/etc., plus any custom roles) per subscription, the ARM analog of `src/graph/roleDefinitions.ts` + `src/cache/roleDefinitionsCache.ts`.

**Principal-name resolution** — `src/arm/principalEnrichment.ts`: unlike the directory plane's `$expand=principal`, ARM's role assignment/PIM objects return only a bare `principalId` GUID for every principal type — there is no ARM-side expand. User names are resolved via `resolveUserDisplayNames` (`src/graph/userDirectory.ts`, new in V3) and service-principal names via the existing `resolveServicePrincipalNames`; group holders stay unresolved by design, same as the directory plane.

**Error handling** — `src/arm/armErrors.ts`: `classifyArmError` is the ARM analog of `src/tools/shared/graphErrors.ts`'s `classifyGraphError`. `src/tools/shared/runTool.ts` dispatches to whichever classifier matches the thrown error's type (`isRestError` → ARM, else → Graph), so every pre-V3 tool's error handling is completely unaffected. 429 throttling on ARM needs no custom retry code — `@azure/core-rest-pipeline`'s default pipeline already honors `Retry-After`, unlike the Graph client which needed a hand-configured `RetryHandler` (`src/graph/throttling.ts`).

**Multi-tenant isolation, unchanged.** Every ARM client is keyed by `tenantId` (and subscriptionId), exactly like the Graph client cache; the credential comes from the same per-tenant `getCredential(tenantId)`. Tools resolve the tenant via the existing `resolveTenantSelector(args.tenant)` — no new tenant plumbing was needed.

## Architecture for the hosted HTTP transport

Brief note — see `SECURITY.md` §12 and `SETUP.md` for the full picture. `src/http/httpServer.ts` is **stateless**: one `McpServer` + one `StreamableHTTPServerTransport` constructed per POST (`sessionIdGenerator: undefined`), not one long-lived server instance. Every tool is a plain request/response Graph/ARM read with no notifications/sampling/progress streaming to justify a session, so there's nothing a session would buy that a fresh instance per request doesn't already give for free — and it sidesteps needing any session-affinity story across replicas.

Per-request caller identity (who's calling, for the audit log) is threaded via `AsyncLocalStorage` (`src/audit/callerContext.ts`), not as an explicit parameter passed into `runTool`. The reason is `resolveTenantSelector` (`src/tools/shared/tenantSelector.ts`) — it's called *inside* each tool body, below `runTool`, not by `runTool` itself. Per-user tenant authorization (see "Out of scope" below) will need caller identity at that exact call site. Threading a parameter would mean a 12-file signature change now (into `runTool`) and another 12-file change later (from `runTool` down into every tool body). ALS reaches both call sites — today's audit logger and tomorrow's tenant-authorization check — with zero signature changes anywhere.

## Tech stack

- **Language:** TypeScript, `strict` mode on (`tsconfig.json` — catches null/type issues before runtime, which matters more than usual for a tool that reads real production access data).
- **MCP:** `@modelcontextprotocol/sdk`. Two transports: stdio (default, tested against Claude Desktop) and a hosted Streamable HTTP transport (Azure Container Apps) built on Express, with inbound bearer-token verification via `jose`. See "Architecture for the hosted HTTP transport" below and `SECURITY.md` §12.
  - **`jose` is pinned to v5, not v6, deliberately.** v6 is ESM-only. Production would cope — Node 22.12+ can `require()` an ESM graph — but Jest cannot: its synchronous require-ESM path needs Node ≥24.9, which this repo's pinned Node 22 doesn't have, so a static `import` from `jose@6` would break every test importing `src/auth/callerToken.ts`. The alternative (a lazy `await import("jose")`) only works under `NODE_OPTIONS=--experimental-vm-modules`, which would mean every `npm test`/CI run carrying an experimental flag forever. `jose@5.10.0` ships a real dual CJS/ESM build, so a plain static import works everywhere with no flags. Revisit once `engines` moves to Node ≥24.9 — at that point v6 works fine under Jest and there's no reason to stay a major version behind.
- **Auth:** `@azure/identity` `ClientSecretCredential` (client-credentials / app-only flow) — don't hand-roll OAuth. Shared unchanged across both API planes (see V3 architecture above).
- **Graph:** `@microsoft/microsoft-graph-client`, mostly v1.0 endpoints; transitive role assignments require `/beta` + `ConsistencyLevel: eventual` header.
- **ARM (V3):** `@azure/arm-authorization` (Azure RBAC role assignments/definitions and Azure-resource PIM in one package), `@azure/arm-subscriptions` (subscription discovery), `@azure/arm-resources` (resource-group enumeration), `@azure/core-rest-pipeline` (imported directly for `RestError`/`isRestError` in error classification — kept as an explicit dependency rather than relying on transitive resolution, since it's imported directly). Typed, first-party SDKs chosen deliberately over hand-rolled REST for the new plane — see the V3 plan for the full rationale; the existing Graph client was deliberately *not* migrated to the newer typed Graph SDK in the same pass.
- **Validation:** `zod` for every tool's input schema.
- **Secrets:** `.env` locally (git-ignored), Key Vault is the stated production target — don't build anything that assumes `.env` is the permanent story.
- **Testing:** Jest. Unit tests mock Graph responses — never call live Graph from a unit test. Integration tests that do hit the tenant must be gated behind an explicit env flag.

## Key Graph endpoints (see dev plan §2.2 for the full table)

| Need | Endpoint | Permission |
|---|---|---|
| Find a user | `GET /users?$filter=...` | `User.Read.All` |
| Role definitions | `GET /roleManagement/directory/roleDefinitions` | `RoleManagement.Read.Directory` |
| Role assignments | `GET /roleManagement/directory/roleAssignments?$filter=...` | `RoleManagement.Read.Directory` |
| Transitive (via groups) | `GET /beta/roleManagement/directory/transitiveRoleAssignments` | `RoleManagement.Read.Directory` |
| PIM eligible | `GET /roleManagement/directory/roleEligibilityScheduleInstances` | `RoleManagement.Read.Directory` |
| PIM active | `GET /roleManagement/directory/roleAssignmentScheduleInstances` | `RoleManagement.Read.Directory` |
| Audit history | `GET /auditLogs/directoryAudits` | `AuditLog.Read.All` |
| Resolve service principal name | `GET /servicePrincipals/{id}?$select=id,displayName,appId` | `Application.Read.All` |
| Directory-role activation history (V3) | `GET /roleManagement/directory/roleAssignmentScheduleRequests` | `RoleAssignmentSchedule.ReadWrite.Directory` |
| PIM-for-Groups eligible (V3) | `GET /identityGovernance/privilegedAccess/group/eligibilityScheduleInstances` | `PrivilegedEligibilitySchedule.Read.AzureADGroup` |
| PIM-for-Groups active (V3) | `GET /identityGovernance/privilegedAccess/group/assignmentScheduleInstances` | `PrivilegedAssignmentSchedule.Read.AzureADGroup` |

Before writing code against any of these, verify the response shape in Graph Explorer (aka.ms/ge) first — this is called out repeatedly in the dev plan as the highest-leverage habit on the project.

## Key ARM endpoints (V3 — see the V3 architecture section above)

| Need | Operation | Grant |
|---|---|---|
| Discover subscriptions | `SubscriptionClient.subscriptions.list()` | Reader at root management group |
| Standing Azure RBAC assignments | `AuthorizationManagementClient.roleAssignments.listForScope(scope)` | Reader (covers `Microsoft.Authorization/*/read`) |
| Azure-resource PIM active | `AuthorizationManagementClient.roleAssignmentScheduleInstances.listForScope(scope)` | Reader |
| Azure-resource PIM eligible | `AuthorizationManagementClient.roleEligibilityScheduleInstances.listForScope(scope)` | Reader |
| Azure-resource PIM activation history | `AuthorizationManagementClient.roleAssignmentScheduleRequests.listForScope(scope)` | Reader |
| Azure role definitions | `AuthorizationManagementClient.roleDefinitions.list(scope)` | Reader |

Same discipline applies here as to Graph: verify a real subscription's response shape before relying on an undocumented field, and don't assume a server-side `$filter` works until it's confirmed (see the client-side `requestType`/`action` filtering in `getAzureRoleActivationHistory.ts` / `getDirectoryRoleActivationHistory.ts` — neither field was confirmed as server-side filterable in Microsoft's docs, so both filter in memory instead, the same caution `get_recent_role_changes` already applies to `directoryAudits` fields).

## Working style

- Prove every Graph query in Graph Explorer before coding it. Same discipline applies to ARM queries against a real subscription (V3) — there's no ARM equivalent of Graph Explorer, so a real subscription/tenant is the only way to confirm a response shape.
- Lead with a plain-English explanation of an approach before showing implementation.
- Call out non-obvious design decisions inline in code comments, not just in chat — the maintainer needs to be able to read and modify this themselves.
- If a request would violate a constraint above (e.g., "just add write access to fix this faster"), flag it rather than complying silently — this happened for real during V3 (the `RoleAssignmentSchedule.ReadWrite.Directory` permission surprise) and the call was made explicitly rather than decided silently.
- Cache role definitions in memory — they rarely change, and refetching wastes Graph/ARM calls.
- When adding v2 features (multi-tenant support, new tools, or Graph queries), verify the logic works against both configured tenants (primary + `fabrikam`) via integration tests before merging. For V3's ARM tools specifically, this also requires the Reader grant (and, for `get_user_group_pim_eligibility`, a PIM-governed test group) to actually be in place in both tenants before an integration test can pass.

## Key learnings from V1 implementation

- **User search ambiguity:** $filter with startswith returns exact duplicates if a user has multiple accounts (e.g., "jordan lee" + "admin) jordan lee"). Switched to $search, which is fuzzy and avoids this. Tool now uses `resolveUsers` (returns all matches up to a cap) instead of single-match-only error path; higher-level tools aggregate role data across all matched accounts.
- **PIM standings are permanent:** A standing (time-unlimited) PIM-eligible or active role assignment should not be treated as a time-boxed activation with an expiry. Check `scheduleInfo` on PIM instances to distinguish active from eligible.
- **Audit log pagination:** Graph audit calls return nextLinks; must page through to honor the full date window requested (not capped by default page size).
- **Service principal display names:** Service principals are only visible to `Application.Read.All`; narrower scopes (User.Read.All, RoleManagement.Read.Directory) return GUIDs only. Maintain a cached directory of servicePrincipals in memory during a tool invocation.
- **30-day audit retention:** Audit log retention is 30 days; role-change queries beyond that should return a clear error, not silent partial results.

## Key learnings from V3 implementation

- **A permission's name lies about its read/write boundary.** `roleAssignmentScheduleRequests` (directory-role activation history) requires `RoleAssignmentSchedule.ReadWrite.Directory` for a plain `GET` — the read-only-named `RoleAssignmentSchedule.Read.Directory` only covers the thinner current-state endpoints (`roleAssignmentSchedules`/`roleAssignmentScheduleInstances`), not the request-transaction detail. Confirmed against Microsoft's own permissions tables, not assumed. Don't infer a Graph endpoint's real permission requirement from a sibling endpoint's — verify each one independently.
- **ARM SDK pagination and throttling are already solved.** Every `@azure/arm-*` list operation returns a `PagedAsyncIterableIterator` — a plain `for await (const item of client.foo.listForScope(...))` walks every page with no manual `nextLink` loop needed (unlike Graph, where `get_recent_role_changes`/`get_directory_role_activation_history` both hand-roll that loop). Similarly, `@azure/core-rest-pipeline`'s default pipeline already retries on 429 with `Retry-After` — no custom `RetryHandler` equivalent was needed for ARM.
- **PIM-for-Groups uses its own field casing.** `assignmentType`/`accessId`/`memberType` on the `/identityGovernance/privilegedAccess/group/...` endpoints are lowercase (`"activated"`, `"member"`, `"direct"`) — distinct from both the directory-role PIM enum (`"Activated"`, capitalized) and the ARM PIM enum (`"Activated"`, also capitalized). Don't normalize across these three PIM surfaces; each is a genuinely different API with its own documented values.
- **`$expand` works across API families, not just within one.** The PIM-for-Groups schedule-instance endpoints support `$expand=group`, returning the group's `displayName` inline — avoided a second Graph round-trip (and a planned `groupDirectory.ts` resolver module) entirely, the same way `get_role_assignments` already gets user names for free via `$expand=principal`.
- **ARM has no bare-metal principal name resolution.** Unlike Graph's `$expand=principal`, ARM's `roleAssignments`/PIM objects return only a `principalId` GUID for every principal type, with no ARM-side expand/select to populate a name — Azure RBAC principal-name resolution for users always needs a separate Graph call (`resolveUserDisplayNames`), even though the assignment itself came from ARM.
- **A masked server error can hide a real permission gap underneath it.** Node's global `fetch` (which `@microsoft/microsoft-graph-client`'s HTTP handler calls internally) sends `Accept-Language: *` whenever no explicit header is set, and Graph's PIM endpoints reject that wildcard with a `400 CultureNotFoundException` — already known and fixed for the schedule-*instance* endpoints (`pimSchedules.ts` sets `Accept-Language: en-US` explicitly), but not yet applied when `pimScheduleRequests.ts`'s schedule-*request* endpoint was added, so it resurfaced there and looked identical, at the status-code level, to "tenant lacks P2 licensing." Fixing the header revealed the *actual* error underneath: a `403 PermissionScopeNotGranted` for `RoleAssignmentSchedule.ReadWrite.Directory` — a real, separate permission gap the culture bug had been hiding the whole time. Don't assume the first error you see from a Graph PIM endpoint is the real one; strip the confound (explicit `Accept-Language`) before concluding what's actually wrong. Any *new* PIM endpoint added later needs this same explicit header from the start.
- **Azure's own "insufficient permission" isn't always a 403.** `queryEachScope`'s degrade-gracefully contract (`src/arm/scopeResolver.ts`) originally only recognized a plain `403` as "this scope is denied, skip it and keep going." Live testing found that `roleAssignmentScheduleInstances`/`roleEligibilityScheduleInstances` reject an unfiltered (all-principals) query with a `400` and `code: "InsufficientPermissions"` instead, when the caller only holds Reader — a status code the degrade-gracefully path didn't recognize, so the one denied scope took down the entire tool call instead of just being skipped. Fixed by widening the classifier (`isArmScopeAccessDenied` in `armErrors.ts`) rather than assuming every Azure permission failure arrives as a 403. See "Known open issues" above for the specific subscription this surfaced on, which is still unresolved.
- **An inherited ARM assignment is not a duplicate — but it will appear as one if you don't dedupe.** `roleAssignments`/PIM schedule-instance `listForScope` calls return everything inherited from parent scopes (a management group, or root `"/"`), by Azure's own documented design — so scanning every subscription in a tenant (the default, no-explicit-scope path every `get_azure_*` tool takes) returns the *same* root/management-group-scoped assignment once per subscription, not once total. Confirmed live: a single root-scope assignment came back 18 times in an 18-subscription tenant. Azure's own `id` for the record is stable across those repeats (it's the same object, just visible from multiple scopes), so that's the correct de-dup key — not `(principalId, roleDefinitionId, scope)`, which two genuinely distinct assignments could share. See `firstSeenById` in `scopeResolver.ts`.