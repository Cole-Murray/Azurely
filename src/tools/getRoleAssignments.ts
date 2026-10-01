import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getGraphClient } from "../graph/client";
import { resolveTenantSelector, tenantSelectorField } from "./shared/tenantSelector";
import { withEventualConsistency } from "../graph/advancedQuery";
import { requireRoleIdentifier, resolveRoleDefinition } from "./shared/roleLookup";
import { runTool } from "./shared/runTool";
import { resolveServicePrincipalNames } from "../graph/servicePrincipalDirectory";
import type { RoleDefinition } from "../cache/roleDefinitionsCache";

/**
 * One principal (user, group, or service principal) holding a directory
 * role, either directly or transitively (via nested group membership).
 */
export interface RoleAssignmentHolder {
  principalId: string;
  /** Derived from the principal's @odata.type, e.g. "user" | "group" | "servicePrincipal". */
  principalType: string;
  /**
   * Absent when Graph doesn't return a populated displayName for the
   * expanded principal - see the comment in mapAssignmentEntry for why
   * this happens under our permission set and why we don't work around it.
   */
  principalDisplayName?: string;
  /**
   * Always undefined in v1. Graph's assignedPrincipals(transitive=true)
   * endpoint (see getRoleAssignmentsCore) returns the flattened set of
   * principals reached via group membership, but doesn't say *which* group
   * carried a given user's assignment - resolving that would mean fetching
   * each candidate group's membership separately, which needs
   * Group.Read.All/GroupMember.Read.All. That's outside this project's
   * granted permissions (see CLAUDE.md's least-privilege constraint), so
   * this field is kept for API stability but left unpopulated rather than
   * guessed at.
   */
  viaGroupId?: string;
}

export interface RoleAssignmentsResult {
  role: { id: string; displayName: string };
  direct: RoleAssignmentHolder[];
  transitive?: RoleAssignmentHolder[];
}

/**
 * Shape of a unifiedRoleAssignment entry from the v1.0 roleAssignments
 * endpoint with $expand=principal. See:
 * https://learn.microsoft.com/graph/api/resources/unifiedroleassignment
 */
interface RawRoleAssignmentEntry {
  principalId?: string;
  principal?: {
    id?: string;
    displayName?: string;
    "@odata.type"?: string;
  };
}

/**
 * Shape of an entry from roleDefinitions/{id}/assignedPrincipals - a flat
 * directoryObject, NOT wrapped in a `principal` sub-object like
 * unifiedRoleAssignment is. See:
 * https://learn.microsoft.com/graph/api/unifiedroledefinition-assignedprincipals?view=graph-rest-beta
 */
interface RawAssignedPrincipal {
  id?: string;
  displayName?: string | null;
  "@odata.type"?: string;
}

function derivePrincipalType(odataType: string | undefined): string {
  if (!odataType) {
    return "unknown";
  }
  return odataType.replace("#microsoft.graph.", "");
}

function mapAssignmentEntry(entry: RawRoleAssignmentEntry): RoleAssignmentHolder {
  const principal = entry.principal;
  // Only RoleManagement.Read.Directory + User.Read.All are granted here (no
  // Group.Read.All / Directory.Read.All - see CLAUDE.md's least-privilege
  // constraint). That means Graph may return the expanded `principal`
  // object for a group or service-principal holder without a populated
  // displayName, even though the id and @odata.type are still present. We
  // deliberately do NOT widen the permission scope to work around this -
  // principalDisplayName is just left undefined and the caller still gets
  // principalType + principalId to work with.
  return {
    principalId: principal?.id ?? entry.principalId ?? "",
    principalType: derivePrincipalType(principal?.["@odata.type"]),
    principalDisplayName: principal?.displayName,
  };
}

function mapAssignedPrincipal(entry: RawAssignedPrincipal): RoleAssignmentHolder {
  return {
    principalId: entry.id ?? "",
    principalType: derivePrincipalType(entry["@odata.type"]),
    principalDisplayName: entry.displayName ?? undefined,
  };
}

/**
 * Fills in `principalDisplayName` for service-principal holders that came
 * back from Graph without one. Only service principals are handled here: user
 * names already arrive via $expand=principal (User.Read.All), and group names
 * would need Group.Read.All, which is intentionally not granted (see
 * CLAUDE.md) - so group holders keep an undefined display name by design.
 *
 * Mutates the holders in place across every array passed in (direct +
 * transitive), collecting their ids into a single resolve call so the
 * service-principal lookups happen once and share the module-level cache.
 */
async function enrichServicePrincipalNames(tenantId: string, holderGroups: RoleAssignmentHolder[][]): Promise<void> {
  const unresolved = holderGroups
    .flat()
    .filter((holder) => holder.principalType === "servicePrincipal" && !holder.principalDisplayName && holder.principalId);

  if (unresolved.length === 0) {
    return;
  }

  const names = await resolveServicePrincipalNames(
    tenantId,
    unresolved.map((holder) => holder.principalId),
  );

  for (const holder of unresolved) {
    const name = names.get(holder.principalId);
    if (name) {
      holder.principalDisplayName = name;
    }
  }
}

/**
 * Core lookup logic, exported separately from the tool registration so
 * `assess_role_risk` (built alongside this tool) can call it directly
 * without going through the MCP tool-call plumbing.
 */
export async function getRoleAssignmentsCore(tenantId: string, role: RoleDefinition, includeTransitive: boolean): Promise<RoleAssignmentsResult> {
  const client = getGraphClient(tenantId);

  const directResponse = await client
    .api("/roleManagement/directory/roleAssignments")
    .filter(`roleDefinitionId eq '${role.id}'`)
    .expand("principal")
    .get();
  const direct: RoleAssignmentHolder[] = ((directResponse?.value ?? []) as RawRoleAssignmentEntry[]).map((entry) => mapAssignmentEntry(entry));

  let transitive: RoleAssignmentHolder[] | undefined;
  if (includeTransitive) {
    // CLAUDE.md's endpoint table pointed at
    // /beta/roleManagement/directory/transitiveRoleAssignments, but that
    // endpoint (confirmed live against the tenant, and in Microsoft's own
    // docs) requires a $filter on principalId - it answers "what roles does
    // this principal hold," not "who holds this role." The role-centric
    // equivalent is roleDefinitions/{id}/assignedPrincipals(transitive=true)
    // - same RoleManagement.Read.Directory permission, still /beta + a
    // required ConsistencyLevel: eventual header, but scoped by the role id
    // already being in the path rather than a $filter. See:
    // https://learn.microsoft.com/graph/api/unifiedroledefinition-assignedprincipals?view=graph-rest-beta
    // transitive=true returns the *union* of every directly-assigned
    // principal (including groups) and every user reached by nested
    // membership in those groups, so it always duplicates everything
    // already in `direct` - filter those out below to keep `transitive`
    // meaning "additional principals reached via group membership," which
    // is what assess_role_risk's severity heuristics assume it means.
    //
    // Also note: hitting /beta means calling .version("beta") on the
    // request, NOT prefixing the path with "/beta" - .api(path) appends
    // path to the client's default v1.0 base URL rather than special-casing
    // a leading "/beta/" segment, so a path-prefixed call 400s with
    // "Resource not found for the segment 'beta'".
    const transitiveResponse = await withEventualConsistency(
      client.api(`/roleManagement/directory/roleDefinitions/${role.id}/assignedPrincipals(transitive=true)`).version("beta"),
    ).get();
    const directIds = new Set(direct.map((holder) => holder.principalId));
    transitive = ((transitiveResponse?.value ?? []) as RawAssignedPrincipal[])
      .map((entry) => mapAssignedPrincipal(entry))
      .filter((holder) => !directIds.has(holder.principalId));
  }

  // Resolve service-principal holders (which Graph returns as bare GUIDs
  // under our permission set) to human-readable names. Done after building
  // both arrays so a single batched lookup covers direct + transitive.
  await enrichServicePrincipalNames(tenantId, transitive ? [direct, transitive] : [direct]);

  return {
    role: { id: role.id, displayName: role.displayName },
    direct,
    transitive,
  };
}

const inputShape = {
  roleId: z.string().uuid().optional(),
  roleName: z.string().trim().min(2).optional(),
  includeTransitive: z.boolean().optional(),
  tenant: tenantSelectorField,
};

/**
 * Registers `get_role_assignments`: lists every principal that holds a
 * given directory role, directly and (by default) transitively via nested
 * group membership.
 *
 * The input schema is a flat zod raw shape (roleId and roleName are both
 * optional), because a flat shape can't express "exactly one of these two
 * is required" on its own - the SDK would happily accept a call with
 * neither. So that cross-field rule is checked by requireRoleIdentifier
 * (shared/roleLookup.ts) as the very first thing inside the callback,
 * before resolveRoleDefinition or any Graph call runs - guaranteeing zero
 * Graph calls happen for this case and a "validation_error" audit status.
 */
export function registerGetRoleAssignments(server: McpServer): void {
  server.registerTool(
    "get_role_assignments",
    {
      description: "List the users, groups, and service principals that hold a given Entra ID directory role, directly and transitively via group membership.",
      inputSchema: inputShape,
    },
    async (args) => {
      return runTool("get_role_assignments", args, async () => {
        requireRoleIdentifier(args);

        const tenantId = resolveTenantSelector(args.tenant).tenantId;
        const role = await resolveRoleDefinition(tenantId, { roleId: args.roleId, roleName: args.roleName });
        return getRoleAssignmentsCore(tenantId, role, args.includeTransitive ?? true);
      });
    },
  );
}
