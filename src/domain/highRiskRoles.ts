/**
 * Curated, hand-written risk catalog for well-known built-in Entra roles,
 * keyed by their fixed role template ID (these IDs are the same across every
 * tenant - see Microsoft's "Entra built-in roles" reference). This is
 * security-communication content, not something derived from Graph, so it
 * needs security-owner review before being treated as authoritative - this is
 * a starting v1 set covering the highest-blast-radius roles, not exhaustive.
 * A role not listed here falls back to the raw rolePermissions Graph returns
 * (see explainDirectoryRole.ts).
 */

export type RiskTier = "critical" | "high" | "medium" | "low";

export interface HighRiskRoleEntry {
  riskTier: RiskTier;
  summary: string;
}

export const HIGH_RISK_ROLES: Record<string, HighRiskRoleEntry> = {
  "62e90394-69f5-4237-9190-012177145e10": {
    riskTier: "critical",
    summary: "Global Administrator - unrestricted access to every Entra ID and Microsoft 365 admin capability, including managing all other admin roles.",
  },
  "e8611ab8-c189-46e8-94e1-60213ab1f814": {
    riskTier: "critical",
    summary: "Privileged Role Administrator - can grant or revoke any directory role, including Global Administrator, to any user.",
  },
  "fe930be7-5e62-47db-91af-98c3a49a38b1": {
    riskTier: "high",
    summary: "User Administrator - can create/delete users and reset passwords, including for other admins in some configurations.",
  },
  "194ae4cb-b126-40b2-bd5b-6091b380977d": {
    riskTier: "high",
    summary: "Security Administrator - can read and change security configuration across Entra ID and Microsoft 365 security products.",
  },
  "b1be1c3e-b65d-4f19-8427-f6fa0d97feb9": {
    riskTier: "high",
    summary: "Conditional Access Administrator - can create or modify Conditional Access policies, which gate how every user authenticates.",
  },
  "9b895d92-2cd3-44c7-9d02-a6ac2d5ea5c3": {
    riskTier: "high",
    summary: "Application Administrator - can manage all app registrations, including granting an app the permissions it requests.",
  },
  "729827e3-9c14-49f7-bb1b-9608f156bbb8": {
    riskTier: "medium",
    summary: "Helpdesk Administrator - can reset passwords and manage sign-in for non-admin users and some limited admin roles.",
  },
};
