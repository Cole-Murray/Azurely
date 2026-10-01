import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveTenantSelector, tenantSelectorField } from "./shared/tenantSelector";
import { getGraphClient } from "../graph/client";
import { withEventualConsistency } from "../graph/advancedQuery";
import { runTool } from "./shared/runTool";

export interface RoleChangeEntry {
  activityDateTime: string;
  activityDisplayName: string;
  initiatedBy: string; // a UPN or app display name, whichever the raw entry has - see mapping below
  targetResources: Array<{ displayName: string; type: string }>;
  result: "success" | "failure";
}

export interface RecentRoleChangesResult {
  since: string; // ISO date string
  changes: RoleChangeEntry[];
  /**
   * True when the caller passed `limit` and more matching entries existed
   * after paging the full date window. Omit/undefined means the date window
   * was fully consumed (or `limit` was not set).
   */
  truncated?: boolean;
}

/** Shape of a single raw entry from GET /auditLogs/directoryAudits - loosely typed since this endpoint's shape is inconsistently documented and worth re-confirming in Graph Explorer before relying on it further. */
interface RawDirectoryAuditEntry {
  activityDateTime: string;
  activityDisplayName: string;
  initiatedBy?: {
    user?: { userPrincipalName?: string };
    app?: { displayName?: string };
  };
  targetResources?: Array<{ displayName?: string; userPrincipalName?: string; type?: string }>;
  result?: string;
}

interface DirectoryAuditsPage {
  value?: RawDirectoryAuditEntry[];
  "@odata.nextLink"?: string;
}

// Graph returns at most one page per request. $top here is the *page* size,
// not the caller's result cap - we follow @odata.nextLink until the date
// window is exhausted (or an optional caller limit is reached after filtering).
const PAGE_SIZE = 100;

function mapEntry(raw: RawDirectoryAuditEntry): RoleChangeEntry {
  return {
    activityDateTime: raw.activityDateTime,
    activityDisplayName: raw.activityDisplayName,
    // Audit log entries are initiated by either a human user or an
    // application, never both - exactly one of these nested objects should
    // be populated. Confirm this exact nesting in Graph Explorer before
    // relying on it further; this endpoint's shape is inconsistently
    // documented.
    initiatedBy: raw.initiatedBy?.user?.userPrincipalName ?? raw.initiatedBy?.app?.displayName ?? "unknown",
    targetResources: (raw.targetResources ?? []).map((t) => ({
      displayName: t.displayName ?? t.userPrincipalName ?? "unknown",
      type: t.type ?? "unknown",
    })),
    result: raw.result === "success" ? "success" : "failure",
  };
}

/**
 * Fetches every RoleManagement directoryAudits page in the date window by
 * following @odata.nextLink. A single Graph response is only one page
 * (typically <=100 rows); without this loop, a busy 30-day window silently
 * truncates at the first page even when the caller asked for "all" results.
 *
 * ConsistencyLevel: eventual is re-applied on every page - nextLink URLs
 * carry the OData query string but not custom headers.
 */
async function fetchAllDirectoryAuditPages(
  tenantId: string,
  since: string,
): Promise<RawDirectoryAuditEntry[]> {
  const client = getGraphClient(tenantId);
  const rawEntries: RawDirectoryAuditEntry[] = [];

  let response: DirectoryAuditsPage = await withEventualConsistency(
    client
      .api("/auditLogs/directoryAudits")
      .filter(`category eq 'RoleManagement' and activityDateTime ge ${since}`)
      .orderby("activityDateTime desc")
      .top(PAGE_SIZE),
  ).get();

  rawEntries.push(...(response.value ?? []));

  while (response["@odata.nextLink"]) {
    const nextLink = response["@odata.nextLink"];
    console.error(
      `[get_recent_role_changes] following nextLink (collected ${rawEntries.length} entries so far)`,
    );
    response = await withEventualConsistency(client.api(nextLink)).get();
    rawEntries.push(...(response.value ?? []));
  }

  return rawEntries;
}

/**
 * The core Graph query behind get_recent_role_changes: every directory
 * audit log entry in the date window scoped to the "RoleManagement"
 * category (role assignments/removals, PIM activations, etc.), most
 * recent first. Pages through @odata.nextLink so the result is not capped
 * at a single $top page.
 *
 * @param limit Optional post-filter cap. When omitted, every entry in the
 *   date window is returned. When set, the list is sliced and `truncated`
 *   is set if anything was cut.
 */
export async function getRecentRoleChangesCore(
  tenantId: string,
  days: number,
  limit?: number,
  userFilter?: string,
): Promise<RecentRoleChangesResult> {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const rawEntries = await fetchAllDirectoryAuditPages(tenantId, since);
  let changes = rawEntries.map(mapEntry);

  if (userFilter) {
    // Not folded into the server-side $filter above because
    // directoryAudits' nested initiatedBy/targetResources structures aren't
    // reliably filterable server-side - an in-memory post-filter over the
    // fully paged date window is the safer bet. Worth revisiting in Graph
    // Explorer later if that turns out to be wrong.
    const needle = userFilter.toLowerCase();
    changes = changes.filter(
      (entry) =>
        entry.initiatedBy.toLowerCase().includes(needle) ||
        entry.targetResources.some((t) => t.displayName.toLowerCase().includes(needle)),
    );
  }

  if (limit !== undefined && changes.length > limit) {
    return { since, changes: changes.slice(0, limit), truncated: true };
  }

  return { since, changes };
}

const getRecentRoleChangesInputShape = {
  // Capped at 30, not just as a sane default but because it's the real
  // ceiling: /auditLogs/directoryAudits 400s on any activityDateTime filter
  // older than the tenant's actual audit retention window (30 days on
  // Entra ID P1/P2, 7 on Free - confirmed live against this tenant, which
  // is on the 30-day tier). That data isn't paginated-around or delayed,
  // it's already purged by Entra, so asking for more here would always
  // fail regardless of how this tool queries Graph. See
  // classifyGraphError's RETENTION_WINDOW_EXCEEDED_PATTERN for what Graph
  // returns if this cap is ever raised past what the tenant supports.
  days: z.number().int().min(1).max(30).optional(),
  userFilter: z.string().trim().optional(),
  // Optional safety/UX cap after full pagination. Omit to return every
  // RoleManagement audit entry in the date window (can be large).
  limit: z.number().int().min(1).max(10_000).optional(),
  tenant: tenantSelectorField,
};

/**
 * Registers get_recent_role_changes: recent RoleManagement-category entries
 * from the directory audit log, optionally narrowed to a specific user or
 * target by an in-memory substring filter (see getRecentRoleChangesCore).
 */
export function registerGetRecentRoleChanges(server: McpServer): void {
  server.registerTool(
    "get_recent_role_changes",
    {
      description:
        "List Entra ID directory role changes (assignments, removals, PIM activations) from the audit log for the given day window (max 30 - Entra's own audit log retention on this tenant, data older than that has already been purged and cannot be retrieved), most recent first. Pages through the full Graph result set for that window (not just the first page). Optionally filter to changes involving a specific user or target by substring. Pass limit only if you want to cap how many entries are returned after paging.",
      inputSchema: getRecentRoleChangesInputShape,
    },
    async (args) => {
      return runTool("get_recent_role_changes", args, async () => {
        const tenantId = resolveTenantSelector(args.tenant).tenantId;
        return getRecentRoleChangesCore(tenantId, args.days ?? 30, args.limit, args.userFilter);
      });
    },
  );
}
