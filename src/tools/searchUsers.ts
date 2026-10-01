import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveTenantSelector, tenantSelectorField } from "./shared/tenantSelector";
import { searchUsersCore } from "../graph/userDirectory";
import { runTool } from "./shared/runTool";

// Raw zod shape (not z.object(...)) - registerTool's inputSchema takes a
// plain object of per-field schemas so the SDK can both validate input and
// derive the JSON Schema it advertises to Claude for this tool.
const searchUsersInputShape = {
  query: z.string().trim().min(2).max(100),
  limit: z.number().int().min(1).max(50).optional(),
  tenant: tenantSelectorField,
};

/**
 * Registers search_users: a free-text lookup over the directory (by display
 * name, UPN, or mail prefix) backed by searchUsersCore. v1 is single-tenant,
 * but the tenant is still resolved through getDefaultTenantId() rather than
 * hardcoded so this doesn't have to change shape when v2 adds more tenants.
 */
export function registerSearchUsers(server: McpServer): void {
  server.registerTool(
    "search_users",
    {
      description:
        "Search Entra ID users by display name, user principal name, or email. Returns basic profile fields - use this to resolve a person's name to a user object before looking up their role assignments.",
      inputSchema: searchUsersInputShape,
    },
    async (args) => {
      return runTool("search_users", args, async () => {
        const tenantId = resolveTenantSelector(args.tenant).tenantId;
        const limit = args.limit ?? 25;
        const matches = await searchUsersCore(tenantId, args.query, limit);

        // If we got back exactly `limit` results, there may be more matches
        // that Graph never returned - tell Claude so it can ask the user to
        // narrow the query instead of assuming this is the complete list.
        return { query: args.query, matches, truncated: matches.length === limit };
      });
    },
  );
}
