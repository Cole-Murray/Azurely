import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resolveTenantSelector, tenantSelectorField } from "./shared/tenantSelector";
import { listRoleDefinitions } from "../graph/roleDefinitions";
import { runTool } from "./shared/runTool";

const inputShape = {
  query: z.string().trim().max(100).optional(),
  tenant: tenantSelectorField,
};

/**
 * Registers `search_directory_roles`: lists Entra directory role
 * definitions, optionally filtered by a free-text query.
 *
 * Unlike search_users (where the directory is too large to fetch in full,
 * so filtering has to happen server-side via a Graph $filter), the full
 * role definition list is small and cached in memory per tenant - so this
 * tool always fetches the whole list once (cache hit after the first call)
 * and filters client-side, with zero extra Graph calls per query.
 */
export function registerSearchDirectoryRoles(server: McpServer): void {
  server.registerTool(
    "search_directory_roles",
    {
      description: "Search Entra ID directory role definitions by name or description. Omit the query to list every role.",
      inputSchema: inputShape,
    },
    async (args) => {
      return runTool("search_directory_roles", args, async () => {
        const tenantId = resolveTenantSelector(args.tenant).tenantId;
        const roles = await listRoleDefinitions(tenantId);

        const query = args.query?.toLowerCase();
        const matches = query
          ? roles.filter(
              (role) => role.displayName.toLowerCase().includes(query) || (role.description?.toLowerCase().includes(query) ?? false),
            )
          : roles;

        return {
          query: args.query ?? null,
          matches: matches.map((role) => ({
            id: role.id,
            displayName: role.displayName,
            description: role.description,
            isBuiltIn: role.isBuiltIn,
          })),
        };
      });
    },
  );
}
