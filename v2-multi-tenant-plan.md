# V2 Plan: Multi-Tenant Selector Plumbing

## Context

CLAUDE.md calls multi-tenant scanning (many tenants) "the big prize" for v2, and the v1 codebase was deliberately built with a seam for it: every auth/Graph function already takes `tenantId` as a parameter, and `src/config/tenants.ts`'s `getTenants()` returns an array (just one entry today) rather than a single hardcoded value.

V2 as named in CLAUDE.md actually spans three separate efforts — multi-tenant scanning, a PIM activation-history tool, and Azure RBAC review. The maintainer chose to scope **this** plan to multi-tenant scanning only; the other two are separate future efforts.

Within multi-tenant scanning, there are two genuinely separate problems:
1. **How do the 7 tools let a caller select which tenant to query** — this is pure plumbing, fully testable today even with only one tenant configured.
2. **Where does config for a second/60th tenant actually come from** — env vars don't scale, and CLAUDE.md names Key Vault as the eventual production target, but there's no second tenant available right now to validate a real design against.

The explicit call: build (1) now, leave (2) as a clearly-marked TODO rather than guessing at a design with nothing to test it against. This plan only covers (1).

## Design

### New file: `src/tools/shared/tenantSelector.ts`

Mirrors the existing `resolveRoleDefinition` pattern in `src/tools/shared/roleLookup.ts` (tools-facing resolver layer above a pure config/data layer):

```typescript
import { z } from "zod";
import { getDefaultTenantId, getTenantConfig, getTenants, type TenantConfig } from "../../config/tenants";
import { AmbiguousMatchError, NotFoundError } from "./errors";

export const tenantSelectorField = z
  .string()
  .trim()
  .min(1)
  .optional()
  .describe(
    "Optional. Selects which configured tenant to query - matches a tenant's ID (GUID) or its display name (case-insensitive, exact match). Omit to use the default tenant. Only one tenant is configured today, so this currently has no effect.",
  );

export function resolveTenantSelector(selector?: string): TenantConfig {
  if (!selector) {
    return getTenantConfig(getDefaultTenantId());
  }
  const tenants = getTenants();
  const idMatch = tenants.find((t) => t.tenantId === selector);
  if (idMatch) return idMatch;

  const query = selector.trim().toLowerCase();
  const nameMatches = tenants.filter((t) => t.displayName.toLowerCase() === query);
  if (nameMatches.length === 1) return nameMatches[0];
  if (nameMatches.length > 1) {
    throw new AmbiguousMatchError(`"${selector}" matched more than one configured tenant - use the tenant's ID (GUID) to disambiguate.`);
  }
  throw new NotFoundError(
    `No configured tenant matches "${selector}". Known tenants: ${tenants.map((t) => `${t.displayName} (${t.tenantId})`).join(", ")}.`,
  );
}
```

**Why a new file instead of adding to `config/tenants.ts`**: `config/tenants.ts` is a zero-dependency data layer (imported by `auth/`, `graph/`, `tools/`). Throwing `NotFoundError`/`AmbiguousMatchError` from `tools/shared/errors.ts` there would create a backwards dependency (config depending on tools) and give the config layer MCP-specific semantics it shouldn't have. `tools/shared/` is where `roleLookup.ts` already does exactly this job for roles.

**Why exact match, not substring**: `resolveRoleDefinition` uses fuzzy substring matching for role names, which is fine for a convenience lookup. Tenant selection is different — silently routing a security query to the wrong tenant on a loose match is a worse failure than rejecting an inexact selector and asking for the GUID or exact name. Revisit only if real multi-tenant usage shows this is too strict.

### Per-tool change (identical edit × 7)

Files: `searchUsers.ts`, `searchDirectoryRoles.ts`, `getRoleAssignments.ts`, `getUserDirectoryRoles.ts`, `explainDirectoryRole.ts`, `getRecentRoleChanges.ts`, `assessRoleRisk.ts` (all in `src/tools/`).

1. Add `tenant: tenantSelectorField` as the last field in the tool's `inputShape`.
2. Swap the import: `getDefaultTenantId` from `../config/tenants` → `{ resolveTenantSelector, tenantSelectorField }` from `./shared/tenantSelector`.
3. One-line callback change: `const tenantId = getDefaultTenantId();` → `const tenantId = resolveTenantSelector(args.tenant).tenantId;`. Nothing else changes — every tool's `*Core(tenantId, ...)` function already takes `tenantId` as a plain string.

Leave each tool's top-level `description` string unchanged for now — the `tenant` field's own `.describe()` already carries the explanation, and rewriting 7 descriptions to reference "multiple tenants" before a second tenant actually exists is premature and duplicative.

`src/index.ts` needs **no changes** — tenant resolution happens per tool-call, not at registration time.

### Testing

- **One new file**, `tests/unit/tools/shared/tenantSelector.test.ts`: covers omitted selector → default tenant; selector matching by `tenantId`; by `displayName` (including different casing); unknown selector → `NotFoundError`; two same-`displayName` tenants → `AmbiguousMatchError` (construct via a temporary `getTenants` mock since only one real tenant exists).
- **Two smoke assertions added to each of the 7 existing tool test files** (not full duplication — the matching/disambiguation logic is only re-tested once, above):
  1. Passing `tenant: process.env.AZURE_TENANT_ID` explicitly behaves identically to omitting it, and the mocked `getGraphClient` was called with that tenant ID.
  2. `tenant: "does-not-exist"` → `isError: true`, zero recorded Graph requests, `logToolCall` status `"validation_error"`.

### The explicit TODO (in `src/config/tenants.ts`, above `getTenants()`)

```typescript
// TODO(multi-tenant-config): this still returns exactly one entry, read
// from 3 flat env vars. That does NOT scale to many tenants and is an
// OPEN, UNSOLVED problem - not something this pass attempted. Key Vault
// is CLAUDE.md's stated production target for secrets, but a config array
// here would still need a registry of tenantId/displayName/clientId per
// tenant from somewhere. Do not build a config-sourcing mechanism
// speculatively - wait until a second tenant is actually available, then
// design against real constraints instead of guesses. Everything else
// (getTenantConfig, getDefaultTenantId, tools/shared/tenantSelector.ts)
// is already written so that swapping this function's implementation is
// the only change needed when that day comes.
```

## Verification (for whoever implements this later)

1. `npx tsc --noEmit` and `npm run build` clean.
2. `npx jest` — all existing 48 tests plus the new resolver test and 14 new smoke assertions (2 × 7 tools) pass.
3. Manual smoke test against the one real tenant: call any tool with `tenant` omitted (works as today), call it again with `tenant` set to the real tenant's GUID and again with its display name "Contoso Production" (both should behave identically to omitting it), and call it with a bogus tenant string (should cleanly fail validation with no Graph call).

## Not in scope for this pass

- PIM activation-history tool (separate v2 effort — needs new Graph endpoints `roleAssignmentScheduleRequests`/`roleEligibilityScheduleRequests`; the required permission scope needs Graph Explorer verification before implementation, since it may not be covered by the currently-granted `RoleManagement.Read.Directory`).
- Azure RBAC review (separate v2/v3 effort — a different API surface entirely, Azure Resource Manager rather than Microsoft Graph, requiring new `@azure/arm-*` dependencies and a fundamentally different grant model: a Reader-or-narrower Azure RBAC role assignment per subscription, rather than one tenant-wide Graph admin consent).
- Real tenant-config sourcing (Key Vault, a registry file, or otherwise) — deliberately deferred per the TODO above until a second tenant exists to validate against.
