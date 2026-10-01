import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerSearchUsers } from "../tools/searchUsers";
import { registerSearchDirectoryRoles } from "../tools/searchDirectoryRoles";
import { registerGetRoleAssignments } from "../tools/getRoleAssignments";
import { registerGetUserDirectoryRoles } from "../tools/getUserDirectoryRoles";
import { registerExplainDirectoryRole } from "../tools/explainDirectoryRole";
import { registerGetRecentRoleChanges } from "../tools/getRecentRoleChanges";
import { registerAssessRoleRisk } from "../tools/assessRoleRisk";
import { registerGetAzureRoleAssignments } from "../tools/getAzureRoleAssignments";
import { registerGetAzurePimAssignments } from "../tools/getAzurePimAssignments";
import { registerGetAzureRoleActivationHistory } from "../tools/getAzureRoleActivationHistory";
import { registerGetDirectoryRoleActivationHistory } from "../tools/getDirectoryRoleActivationHistory";
import { registerGetUserGroupPimEligibility } from "../tools/getUserGroupPimEligibility";

export const SERVER_NAME = "entra-iam-review-mcp";
export const SERVER_VERSION = "0.1.0";

/**
 * Constructs a fresh McpServer with all 12 tools registered.
 *
 * This is a factory, not a module-scope singleton, because an McpServer
 * owns exactly one transport. The stdio entrypoint (src/index.ts) only ever
 * needs one instance, but the HTTP transport (added in a later step)
 * constructs one McpServer per request - sharing a single instance across
 * concurrent HTTP requests would cross-wire responses between them.
 *
 * Calling this repeatedly is cheap. The 12 registerXxx functions below only
 * attach callbacks that close over module-level zod shape constants - no
 * per-call setup work happens. And every cache the tools rely on
 * (src/cache/*, src/auth/credential.ts, src/graph/client.ts,
 * src/arm/client.ts) is module-global, not tied to a particular server
 * instance - so a freshly constructed server inherits an already-warm
 * cache instead of forcing a re-fetch. Nothing gets re-fetched per request.
 */
export function createServer(): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  // v1 tool order from CLAUDE.md - search_users and search_directory_roles
  // come first because every other tool resolves a user or role by name
  // through them (directly or via the shared lookups in tools/shared/).
  // assess_role_risk comes last because it composes get_role_assignments'
  // core logic rather than duplicating Graph calls.
  registerSearchUsers(server);
  registerSearchDirectoryRoles(server);
  registerGetRoleAssignments(server);
  registerGetUserDirectoryRoles(server);
  registerExplainDirectoryRole(server);
  registerGetRecentRoleChanges(server);
  registerAssessRoleRisk(server);

  // V3: the Azure Resource Manager (ARM) plane, alongside the Graph plane
  // above - see CLAUDE.md / the V3 plan for why these are a genuinely separate
  // permission system (Azure RBAC role assignments, not Graph consent) rather
  // than an extension of the v1/v2 tools. Registered after the v1/v2 tools so
  // the original 7 keep their exact registration order untouched.
  registerGetAzureRoleAssignments(server);
  registerGetAzurePimAssignments(server);
  registerGetAzureRoleActivationHistory(server);
  registerGetDirectoryRoleActivationHistory(server);
  registerGetUserGroupPimEligibility(server);

  return server;
}
