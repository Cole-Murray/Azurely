import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resolveTenantSelector, tenantSelectorField } from "./shared/tenantSelector";
import { runTool } from "./shared/runTool";
import { getAuthorizationClient } from "../arm/client";
import { azureScopeField, resolveAzureScopes, assertScopesDiscovered, assertNotAllScopesDenied, queryEachScope, firstSeenById, type AzureScope } from "../arm/scopeResolver";
import { extractRoleDefinitionGuid, resolveAzureRoleName } from "../arm/roleDefinitions";
import { enrichArmPrincipalNames } from "../arm/principalEnrichment";

/**
 * One self-service PIM activation of an Azure resource role - the
 * resource-plane twin of the Global-Admin-style activation timeline already
 * visible for directory roles (see get_directory_role_activation_history).
 */
export interface AzureRoleActivationEntry {
  principalId: string;
  /** Same "always populated, falls back to Unknown" contract as its sibling tools (getAzureRoleAssignments.ts, getAzurePimAssignments.ts) - ARM's own type marks this optional, but never leaving it undefined keeps the three tools' result shapes consistent. */
  principalType: string;
  principalDisplayName?: string;
  roleDefinitionId: string;
  roleName: string;
  scope: string;
  /** Request lifecycle status, e.g. "Provisioned", "PendingApproval", "Denied" - see Azure's KnownStatus values. */
  status?: string;
  justification?: string;
  ticketNumber?: string;
  ticketSystem?: string;
  requestedDateTime?: string;
  startDateTime?: string;
  endDateTime?: string;
}

export interface AzureRoleActivationHistoryResult {
  scopesQueried: string[];
  activations: AzureRoleActivationEntry[];
  accessDeniedForSomeScopes?: boolean;
}

const ISO_8601_DURATION = /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/;

/**
 * Azure's roleAssignmentScheduleRequests only carries expiration.endDateTime
 * when the activation was requested with an explicit end date/time
 * (expiration.type === "AfterDateTime"). The common case - "activate this
 * role for N hours" via the Azure portal - comes back as
 * expiration.type === "AfterDuration" with only an ISO-8601 duration string
 * (e.g. "PT8H"), leaving endDateTime undefined. Y/M use a 365/30-day
 * approximation, but self-activation durations are effectively always
 * hours/days in practice, so that imprecision doesn't bite here.
 */
function parseIso8601DurationMs(duration: string): number | undefined {
  const match = ISO_8601_DURATION.exec(duration);
  if (!match) {
    return undefined;
  }
  const [, years, months, days, hours, minutes, seconds] = match;
  if (!years && !months && !days && !hours && !minutes && !seconds) {
    return undefined;
  }
  const DAY_MS = 24 * 60 * 60 * 1000;
  let ms = 0;
  if (years) ms += Number(years) * 365 * DAY_MS;
  if (months) ms += Number(months) * 30 * DAY_MS;
  if (days) ms += Number(days) * DAY_MS;
  if (hours) ms += Number(hours) * 60 * 60 * 1000;
  if (minutes) ms += Number(minutes) * 60 * 1000;
  if (seconds) ms += Number(seconds) * 1000;
  return ms;
}

function resolveEndDateTime(
  startDateTime: Date | undefined,
  expiration: { endDateTime?: Date; duration?: string } | undefined,
): string | undefined {
  if (expiration?.endDateTime) {
    return expiration.endDateTime.toISOString();
  }
  if (startDateTime && expiration?.duration) {
    const ms = parseIso8601DurationMs(expiration.duration);
    if (ms !== undefined) {
      return new Date(startDateTime.getTime() + ms).toISOString();
    }
  }
  return undefined;
}

export async function getAzureRoleActivationHistoryCore(tenantId: string, explicitScope: string | undefined): Promise<AzureRoleActivationHistoryResult> {
  const scopes = await resolveAzureScopes(tenantId, explicitScope);
  assertScopesDiscovered(scopes);

  const { perScope, deniedScopes } = await queryEachScope(scopes, async (scope: AzureScope) => {
    const client = getAuthorizationClient(tenantId, scope.subscriptionId);
    const raw = [];
    for await (const request of client.roleAssignmentScheduleRequests.listForScope(scope.path)) {
      raw.push(request);
    }
    return raw;
  });
  assertNotAllScopesDenied(scopes, deniedScopes);

  const activations: AzureRoleActivationEntry[] = [];
  const seenRequestIds = new Set<string>();
  for (const { scope, items } of perScope) {
    for (const request of items) {
      // requestType isn't in RoleAssignmentScheduleRequestFilter's documented
      // server-side filter fields (only principalId/roleDefinitionId/
      // requestorId/status are), so this is filtered client-side rather than
      // relying on an unconfirmed server-side $filter - same caution
      // getRecentRoleChanges.ts applies to directoryAudits fields that
      // aren't reliably filterable server-side. Verify against Graph
      // Explorer / a real subscription before assuming a server-side filter
      // would also work here.
      if (request.requestType !== "SelfActivate" || !request.principalId || !request.roleDefinitionId) {
        continue;
      }
      // A request made at a parent scope (management group, root "/") is
      // returned by every descendant subscription's listForScope call, not
      // just once - see firstSeenById's docstring.
      if (!firstSeenById(seenRequestIds, request.id)) {
        continue;
      }
      const roleName = await resolveAzureRoleName(tenantId, scope.subscriptionId, request.roleDefinitionId);
      activations.push({
        principalId: request.principalId,
        principalType: request.principalType ?? "Unknown",
        roleDefinitionId: extractRoleDefinitionGuid(request.roleDefinitionId),
        roleName,
        scope: request.scope ?? scope.path,
        status: request.status,
        justification: request.justification,
        ticketNumber: request.ticketInfo?.ticketNumber,
        ticketSystem: request.ticketInfo?.ticketSystem,
        requestedDateTime: request.createdOn?.toISOString(),
        startDateTime: request.scheduleInfo?.startDateTime?.toISOString(),
        endDateTime: resolveEndDateTime(request.scheduleInfo?.startDateTime, request.scheduleInfo?.expiration),
      });
    }
  }

  await enrichArmPrincipalNames(tenantId, [activations]);

  return {
    scopesQueried: scopes.map((scope) => scope.path),
    activations,
    ...(deniedScopes.length > 0 ? { accessDeniedForSomeScopes: true as const } : {}),
  };
}

const inputShape = {
  scope: azureScopeField,
  tenant: tenantSelectorField,
};

/**
 * Registers get_azure_role_activation_history: every self-service PIM
 * activation of an Azure resource role at a subscription or resource group -
 * who activated an eligible role, when, for how long, and with what
 * justification/ticket. Scans every subscription the app's service
 * principal can see by default; pass scope to narrow it.
 */
export function registerGetAzureRoleActivationHistory(server: McpServer): void {
  server.registerTool(
    "get_azure_role_activation_history",
    {
      description:
        "List self-service PIM activations of Azure resource roles (Owner, Contributor, etc.) at a subscription or resource group - who activated an eligible role, when, for how long, and with what justification or ticket reference. Scans every subscription the app's service principal can see in this tenant by default; pass scope to narrow it to one subscription or resource group. If accessDeniedForSomeScopes is true in the result, at least one scanned subscription denied access (Reader not yet granted there) and the activation list may be incomplete.",
      inputSchema: inputShape,
    },
    async (args) => {
      return runTool("get_azure_role_activation_history", args, async () => {
        const tenantId = resolveTenantSelector(args.tenant).tenantId;
        return getAzureRoleActivationHistoryCore(tenantId, args.scope);
      });
    },
  );
}
