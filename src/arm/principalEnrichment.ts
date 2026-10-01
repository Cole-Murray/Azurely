import { resolveServicePrincipalNames } from "../graph/servicePrincipalDirectory";
import { resolveUserDisplayNames } from "../graph/userDirectory";

export interface ArmPrincipalHolder {
  principalId: string;
  principalType?: string;
  principalDisplayName?: string;
}

/**
 * Fills in principalDisplayName for every ARM-sourced holder whose
 * principalType is "User" or "ServicePrincipal" (ARM's own PascalCase
 * spelling - matched case-insensitively here since it isn't normalized to
 * the Graph-derived lowercase convention used elsewhere, see the comment on
 * AzureRoleAssignmentHolder for why). Group holders are left with an
 * undefined display name, matching the directory plane's existing
 * Group.Read.All constraint (see CLAUDE.md) - shared across all three Azure
 * RBAC tools (get_azure_role_assignments, get_azure_pim_assignments,
 * get_azure_role_activation_history) so this resolution logic lives in one
 * place instead of being copy-pasted three times.
 *
 * Mutates the holders in place across every list passed in, so a single
 * batched lookup per principal type covers all of them - the same contract
 * enrichServicePrincipalNames uses in getRoleAssignments.ts.
 */
export async function enrichArmPrincipalNames<T extends ArmPrincipalHolder>(tenantId: string, holderLists: T[][]): Promise<void> {
  const all = holderLists.flat();

  const userIds = all
    .filter((holder) => holder.principalType?.toLowerCase() === "user" && !holder.principalDisplayName && holder.principalId)
    .map((holder) => holder.principalId);
  const servicePrincipalIds = all
    .filter((holder) => holder.principalType?.toLowerCase() === "serviceprincipal" && !holder.principalDisplayName && holder.principalId)
    .map((holder) => holder.principalId);

  const [userNames, servicePrincipalNames] = await Promise.all([
    userIds.length > 0 ? resolveUserDisplayNames(tenantId, userIds) : Promise.resolve(new Map<string, string>()),
    servicePrincipalIds.length > 0 ? resolveServicePrincipalNames(tenantId, servicePrincipalIds) : Promise.resolve(new Map<string, string>()),
  ]);

  for (const holder of all) {
    const type = holder.principalType?.toLowerCase();
    const name = type === "user" ? userNames.get(holder.principalId) : type === "serviceprincipal" ? servicePrincipalNames.get(holder.principalId) : undefined;
    if (name) {
      holder.principalDisplayName = name;
    }
  }
}
