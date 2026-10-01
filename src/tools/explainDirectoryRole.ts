import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getGraphClient } from "../graph/client";
import { resolveTenantSelector, tenantSelectorField } from "./shared/tenantSelector";
import { requireRoleIdentifier, resolveRoleDefinition } from "./shared/roleLookup";
import { HIGH_RISK_ROLES, type RiskTier } from "../domain/highRiskRoles";
import { runTool } from "./shared/runTool";

export interface ExplainDirectoryRoleResult {
  role: { id: string; displayName: string; description?: string; isBuiltIn: boolean };
  riskTier?: RiskTier;
  summary: string;
  /** Only populated for the fallback path - a role not in HIGH_RISK_ROLES. */
  rawPermissionActions?: string[];
}

/**
 * Minimal shape we rely on from a roleDefinition Graph response that
 * includes the (nested) rolePermissions collection. This is only used on
 * the fallback path below - the cached RoleDefinition type from
 * roleDefinitionsCache.ts deliberately doesn't carry rolePermissions since
 * most callers (search_directory_roles, etc.) never need it.
 */
interface RoleDefinitionWithPermissions {
  rolePermissions?: { allowedResourceActions?: string[] }[];
}

const inputShape = {
  roleId: z.string().uuid().optional(),
  roleName: z.string().trim().min(2).optional(),
  tenant: tenantSelectorField,
};

/**
 * Registers `explain_directory_role`: given a role (by ID or name), explains
 * what it can do and, for the handful of roles that have been
 * reviewed and written a risk summary for, how risky holding it is.
 *
 * Most Entra built-in roles (and every custom role) aren't in the curated
 * HIGH_RISK_ROLES catalog - that catalog only covers the highest-blast-radius
 * roles that have had a human write a vetted, plain-English summary. For
 * everything else we fall back to Graph's raw rolePermissions so the tool
 * still returns something useful, just without a risk tier nobody has
 * reviewed yet (returning an unvetted "medium" guess would be worse than no
 * tier at all for a tool whose job is answering security questions).
 */
export function registerExplainDirectoryRole(server: McpServer): void {
  server.registerTool(
    "explain_directory_role",
    {
      description:
        "Explain what an Entra ID directory role can do, including a risk tier for well-known high-privilege roles. Provide roleId or roleName.",
      inputSchema: inputShape,
    },
    async (args) => {
      return runTool("explain_directory_role", args, async () => {
        // Same "roleId or roleName" cross-field rule as get_role_assignments -
        // see shared/roleLookup.ts's requireRoleIdentifier for why this can't
        // just live in the zod shape.
        requireRoleIdentifier(args);

        const tenantId = resolveTenantSelector(args.tenant).tenantId;
        const role = await resolveRoleDefinition(tenantId, { roleId: args.roleId, roleName: args.roleName });

        const roleSummary = {
          id: role.id,
          displayName: role.displayName,
          description: role.description,
          isBuiltIn: role.isBuiltIn,
        };

        const curated = HIGH_RISK_ROLES[role.id];
        if (curated) {
          const result: ExplainDirectoryRoleResult = {
            role: roleSummary,
            riskTier: curated.riskTier,
            summary: curated.summary,
          };
          return result;
        }

        // Fallback path: not in the curated catalog (the common case - most
        // roles aren't). Fetch rolePermissions from Graph directly, since
        // the cached RoleDefinition list never carries it.
        //
        // NOTE: rolePermissions is a nested/complex property. Confirm in
        // Graph Explorer (aka.ms/ge) that $select actually returns it on
        // this endpoint before relying on this in production - some Graph
        // endpoints silently omit complex properties even when explicitly
        // selected, per CLAUDE.md's "prove every query first" guidance.
        const client = getGraphClient(tenantId);
        const response = (await client
          .api(`/roleManagement/directory/roleDefinitions/${role.id}`)
          .select(["id", "displayName", "description", "isBuiltIn", "rolePermissions"])
          .get()) as RoleDefinitionWithPermissions;

        // Defensive optional chaining - the exact nesting (rolePermissions
        // as an array with one entry vs. some other shape) should be
        // verified against a live response; this is a best-effort
        // extraction until then, not a confirmed contract.
        const rawPermissionActions: string[] = response?.rolePermissions?.[0]?.allowedResourceActions ?? [];

        const result: ExplainDirectoryRoleResult = {
          role: roleSummary,
          summary: "No curated summary available for this role - showing raw permitted actions instead.",
          rawPermissionActions,
        };
        return result;
      });
    },
  );
}
