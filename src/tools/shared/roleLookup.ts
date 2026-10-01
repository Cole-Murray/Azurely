import { listRoleDefinitions } from "../../graph/roleDefinitions";
import type { RoleDefinition } from "../../cache/roleDefinitionsCache";
import { AmbiguousMatchError, NotFoundError, ToolInputError } from "./errors";

/**
 * The "roleId or roleName" cross-field rule every role-identifying tool
 * needs (get_role_assignments, explain_directory_role) - a flat zod raw
 * shape can't express "at least one of these two required" on its own, so
 * each tool calls this explicitly as the first line of its callback, before
 * resolveRoleDefinition or any Graph call runs. Throwing ToolInputError
 * here means runTool logs it as "validation_error" and guarantees zero
 * Graph calls happen for this case.
 */
export function requireRoleIdentifier(input: { roleId?: string; roleName?: string }): void {
  if (!input.roleId && !input.roleName) {
    throw new ToolInputError("Provide either roleId or roleName.");
  }
}

/**
 * Resolves a role by exact ID or by a case-insensitive display-name match
 * against the cached role definition list. Shared by every tool that
 * accepts "roleId or roleName" input (get_role_assignments,
 * explain_directory_role, assess_role_risk) so the disambiguation rules
 * only live in one place.
 */
export async function resolveRoleDefinition(tenantId: string, input: { roleId?: string; roleName?: string }): Promise<RoleDefinition> {
  const roles = await listRoleDefinitions(tenantId);

  if (input.roleId) {
    const match = roles.find((role) => role.id === input.roleId);
    if (!match) {
      throw new NotFoundError(`No role found with id "${input.roleId}".`);
    }
    return match;
  }

  const query = (input.roleName ?? "").trim().toLowerCase();
  const matches = roles.filter((role) => role.displayName.toLowerCase() === query);
  if (matches.length === 1) {
    return matches[0];
  }
  if (matches.length > 1) {
    throw new AmbiguousMatchError(`"${input.roleName}" matched more than one role - use roleId to disambiguate.`);
  }

  const partialMatches = roles.filter((role) => role.displayName.toLowerCase().includes(query));
  if (partialMatches.length === 1) {
    return partialMatches[0];
  }
  if (partialMatches.length > 1) {
    throw new AmbiguousMatchError(
      `"${input.roleName}" matched multiple roles: ${partialMatches.map((role) => role.displayName).join(", ")}. Use roleId or a more specific roleName.`,
    );
  }

  throw new NotFoundError(`No role found matching "${input.roleName}".`);
}
