import { GraphError } from "@microsoft/microsoft-graph-client";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { RoleDefinition } from "../cache/roleDefinitionsCache";
import { resolveTenantSelector, tenantSelectorField } from "./shared/tenantSelector";
import { HIGH_RISK_ROLES } from "../domain/highRiskRoles";
import { getGraphClient } from "../graph/client";
import { fetchRoleAssignmentScheduleInstances } from "../graph/pimSchedules";
import { listRoleDefinitions } from "../graph/roleDefinitions";
import { getRoleAssignmentsCore, type RoleAssignmentHolder } from "./getRoleAssignments";
import { resolveRoleDefinition } from "./shared/roleLookup";
import { runTool } from "./shared/runTool";

/**
 * This is the only v1 tool that makes zero Graph calls of its own - it's a
 * composite that leans entirely on get_role_assignments (for who holds a
 * role, direct + transitive) and the raw PIM schedule-instance fetchers (for
 * whether a holder is standing/permanent vs. PIM-governed). Its whole job is
 * to apply a set of judgment-call heuristics on top of data those pieces
 * already know how to fetch, not to introduce a new Graph query shape.
 */

export interface RoleRiskFinding {
  severity: "high" | "medium" | "info";
  roleDisplayName: string;
  principalId: string;
  principalDisplayName?: string;
  principalType: string;
  reason: string;
}

export interface AssessRoleRiskResult {
  rolesAssessed: string[];
  findings: RoleRiskFinding[];
  summary: { totalFindings: number; bySeverity: Record<string, number> };
}

/** Per-role intermediate state, before the cross-role "multiple high-risk roles" pass below. */
interface RoleAssessment {
  role: RoleDefinition;
  direct: RoleAssignmentHolder[];
  transitive: RoleAssignmentHolder[];
  /** principalIds with a PIM-active schedule instance for this role - empty (not missing) when PIM data is unavailable. */
  pimActivePrincipalIds: Set<string>;
  /** True only when the PIM schedule-instance calls themselves failed (e.g. non-P2 tenant), not merely "no active instances found." */
  pimUnavailable: boolean;
}

/**
 * Resolves the set of roles to assess. With no roleNames given, this defaults
 * to every role in the curated HIGH_RISK_ROLES catalog (domain/highRiskRoles.ts)
 * tiered "critical" or "high" that actually exists in this tenant's role
 * definitions. That default is intentionally narrower than "every built-in
 * role" - assessing all ~100 built-in roles by default would be slow (one
 * get_role_assignments + one PIM-classification round-trip per role) and
 * mostly noise, since most roles aren't privilege-escalation-relevant. The
 * trade-off: this default is only as complete as the hand-curated catalog -
 * a genuinely high-risk role that hasn't been added to HIGH_RISK_ROLES yet
 * is silently excluded unless the caller passes it explicitly via roleNames.
 */
async function resolveRolesToAssess(tenantId: string, roleNames: string[] | undefined): Promise<RoleDefinition[]> {
  if (roleNames && roleNames.length > 0) {
    return Promise.all(roleNames.map((roleName) => resolveRoleDefinition(tenantId, { roleName })));
  }

  const allRoles = await listRoleDefinitions(tenantId);
  return allRoles.filter((role) => {
    const entry = HIGH_RISK_ROLES[role.id];
    return entry !== undefined && (entry.riskTier === "critical" || entry.riskTier === "high");
  });
}

/**
 * Gathers everything needed to assess one role: who holds it (direct +
 * transitive, via get_role_assignments) and which of those holders are
 * PIM-active (via the raw schedule-instance fetchers, filtered by
 * roleDefinitionId - the "role-centric" query these functions were built to
 * support alongside get_user_directory_roles' "principal-centric" one). Both
 * legs run in parallel since neither depends on the other's result.
 */
async function assessOneRole(tenantId: string, role: RoleDefinition): Promise<RoleAssessment> {
  const client = getGraphClient(tenantId);
  const roleFilter = `roleDefinitionId eq '${role.id}'`;

  const [assignments, pim] = await Promise.all([
    getRoleAssignmentsCore(tenantId, role, true),
    (async () => {
      try {
        // Only the active list feeds a heuristic in v1 (buildFindingsForRole
        // checks pimActivePrincipalIds) - eligible isn't the basis of any
        // finding yet, so it isn't fetched here. Fetching it anyway would
        // double this role's PIM Graph calls for no v1 benefit; add it back
        // if a future heuristic needs eligible state.
        const active = await fetchRoleAssignmentScheduleInstances(client, roleFilter);
        // roleAssignmentScheduleInstances mixes genuine time-boxed PIM
        // activations (assignmentType: "Activated") with standing/permanent
        // grants that happen to surface through the same endpoint
        // (assignmentType: "Assigned"). Only the former is actually
        // PIM-governed - counting "Assigned" holders here would wrongly
        // suppress the "high" finding for someone with permanent,
        // un-time-boxed access to a high-risk role.
        const timeBoxedActive = active.filter((instance) => instance.assignmentType === "Activated");
        return { activePrincipalIds: new Set(timeBoxedActive.map((instance) => instance.principalId)), unavailable: false };
      } catch (err) {
        // Same P2-licensing caveat as get_user_directory_roles: a tenant
        // without Entra ID P2 403s/400s the whole PIM schedule-instance
        // call rather than returning an empty list. That's a licensing
        // fact, not a bug - degrade this one role's PIM data instead of
        // failing the whole multi-role assessment. Only 403/400 mean "not
        // licensed" - anything else (429 exhausted, 500, etc.) is a real
        // failure and must not be silently treated as a licensing gap.
        if (err instanceof GraphError && (err.statusCode === 403 || err.statusCode === 400)) {
          return { activePrincipalIds: new Set<string>(), unavailable: true };
        }
        throw err;
      }
    })(),
  ]);

  return {
    role,
    direct: assignments.direct,
    transitive: assignments.transitive ?? [],
    pimActivePrincipalIds: pim.activePrincipalIds,
    pimUnavailable: pim.unavailable,
  };
}

/**
 * v1 risk heuristics - these are judgment calls meant to be reviewed/tuned
 * by the maintainers and a security reviewer, not authoritative security policy:
 *  - A direct (standing) holder with no matching PIM-active instance is
 *    "high" - permanent access to a high-blast-radius role, un-time-boxed.
 *  - A transitive (group-based) holder is "medium" regardless of PIM state -
 *    RoleManagement.Read.Directory + User.Read.All (no Group.Read.All) means
 *    this tool can see *that* a group carries the role but can't
 *    independently verify who is actually in that group, so it's flagged as
 *    lower-confidence rather than silently trusted.
 *  - If the PIM schedule-instance calls failed for this role (no P2), every
 *    direct holder still gets a "high" finding, but the reason says PIM
 *    status is unknown instead of asserting "non-PIM" with false confidence.
 */
function buildFindingsForRole(assessment: RoleAssessment): RoleRiskFinding[] {
  const { role, direct, transitive, pimActivePrincipalIds, pimUnavailable } = assessment;
  const findings: RoleRiskFinding[] = [];

  for (const holder of direct) {
    if (pimActivePrincipalIds.has(holder.principalId)) {
      // PIM-active governance is working as intended for this holder - no finding.
      continue;
    }
    const reason = pimUnavailable
      ? "standing (non-PIM) assignment to a high-risk role (PIM status unknown - Entra ID P2 data unavailable)"
      : "standing (non-PIM) assignment to a high-risk role";
    findings.push({
      severity: "high",
      roleDisplayName: role.displayName,
      principalId: holder.principalId,
      principalDisplayName: holder.principalDisplayName,
      principalType: holder.principalType,
      reason,
    });
  }

  for (const holder of transitive) {
    findings.push({
      severity: "medium",
      roleDisplayName: role.displayName,
      principalId: holder.principalId,
      principalDisplayName: holder.principalDisplayName,
      principalType: holder.principalType,
      reason: "granted via group membership - membership isn't independently verifiable with the Graph permissions available to this tool",
    });
  }

  return findings;
}

/** Tracks, across every assessed role, which distinct role display names a given principal was seen holding. */
interface PrincipalMembership {
  principalDisplayName?: string;
  principalType: string;
  roleDisplayNames: Set<string>;
}

/**
 * Cross-role pass: a principal holding 2+ of the assessed high-risk roles is
 * itself worth flagging (privilege concentration), independent of whether
 * each individual assignment was already flagged "high" or "medium" above.
 * This is an "info" severity, not "high"/"medium" - it's not asserting the
 * combination is wrong, just surfacing it for a human to judge.
 */
function buildMultiRoleFindings(assessments: RoleAssessment[]): RoleRiskFinding[] {
  const memberships = new Map<string, PrincipalMembership>();

  for (const assessment of assessments) {
    for (const holder of [...assessment.direct, ...assessment.transitive]) {
      const existing = memberships.get(holder.principalId);
      if (existing) {
        existing.roleDisplayNames.add(assessment.role.displayName);
        existing.principalDisplayName ??= holder.principalDisplayName;
      } else {
        memberships.set(holder.principalId, {
          principalDisplayName: holder.principalDisplayName,
          principalType: holder.principalType,
          roleDisplayNames: new Set([assessment.role.displayName]),
        });
      }
    }
  }

  const findings: RoleRiskFinding[] = [];
  for (const [principalId, membership] of memberships) {
    if (membership.roleDisplayNames.size < 2) {
      continue;
    }
    const roleList = [...membership.roleDisplayNames].sort().join(", ");
    findings.push({
      severity: "info",
      roleDisplayName: roleList,
      principalId,
      principalDisplayName: membership.principalDisplayName,
      principalType: membership.principalType,
      reason: `holds multiple high-risk roles: ${roleList}`,
    });
  }
  return findings;
}

function summarize(findings: RoleRiskFinding[]): AssessRoleRiskResult["summary"] {
  const bySeverity: Record<string, number> = {};
  for (const finding of findings) {
    bySeverity[finding.severity] = (bySeverity[finding.severity] ?? 0) + 1;
  }
  return { totalFindings: findings.length, bySeverity };
}

/**
 * Core aggregation logic, exported separately from tool registration - same
 * pattern as get_role_assignments' getRoleAssignmentsCore, kept testable
 * without going through the MCP tool-call plumbing.
 */
export async function assessRoleRiskCore(tenantId: string, roleNames: string[] | undefined): Promise<AssessRoleRiskResult> {
  const roles = await resolveRolesToAssess(tenantId, roleNames);
  const assessments = await Promise.all(roles.map((role) => assessOneRole(tenantId, role)));

  const findings = assessments.flatMap((assessment) => buildFindingsForRole(assessment));
  findings.push(...buildMultiRoleFindings(assessments));

  return {
    rolesAssessed: assessments.map((assessment) => assessment.role.displayName),
    findings,
    summary: summarize(findings),
  };
}

const assessRoleRiskInputShape = {
  // .trim().min(2) per element matches the roleName validation on
  // get_role_assignments/explain_directory_role - without it, an empty or
  // whitespace-only entry reaches resolveRoleDefinition's substring match,
  // which treats "" as matching every cached role and throws a confusing
  // "matched multiple roles: <entire role list>" error instead of a clean
  // input rejection.
  roleNames: z.array(z.string().trim().min(2)).optional(),
  tenant: tenantSelectorField,
};

/**
 * Registers assess_role_risk: applies standing-access and group-based-access
 * heuristics across a set of high-risk directory roles (defaulting to the
 * curated critical/high tier in domain/highRiskRoles.ts) and surfaces
 * findings a human should review - it never blocks or changes anything.
 */
export function registerAssessRoleRisk(server: McpServer): void {
  server.registerTool(
    "assess_role_risk",
    {
      description:
        "Assess standing-access risk across Entra ID's highest-blast-radius directory roles: flags permanent (non-PIM) assignments, group-based assignments whose membership can't be independently verified, and principals holding multiple high-risk roles. Defaults to the curated critical/high risk-tier roles present in this tenant; pass roleNames to assess a specific set instead. Findings are v1 heuristics for human review, not authoritative security policy.",
      inputSchema: assessRoleRiskInputShape,
    },
    async (args) => {
      return runTool("assess_role_risk", args, async () => {
        const tenantId = resolveTenantSelector(args.tenant).tenantId;
        return assessRoleRiskCore(tenantId, args.roleNames);
      });
    },
  );
}
