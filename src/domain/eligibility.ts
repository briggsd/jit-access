import type { Approval, EligibilityRule } from "./config.js";

export interface OrgView {
  /** accountId -> account name, for active accounts only. */
  accounts: Map<string, string>;
  /** OU id -> every account id below it, recursively. */
  accountsByOu: Map<string, string[]>;
  /** Accounts that can never be targeted, such as the management account. */
  excluded: Set<string>;
}

export interface Entitlement {
  accountId: string;
  accountName: string;
  permissionSet: string;
  maxDurationMinutes: number;
  approval: Approval;
  rule: string;
}

export function entitlementsFor(
  userGroups: Set<string>,
  rules: EligibilityRule[],
  org: OrgView,
): Entitlement[] {
  const out: Entitlement[] = [];
  for (const rule of rules) {
    if (!rule.groups.some((g) => userGroups.has(g))) continue;
    const accountIds = new Set(rule.accounts ?? []);
    for (const ou of rule.ous ?? []) {
      for (const id of org.accountsByOu.get(ou) ?? []) accountIds.add(id);
    }
    for (const accountId of accountIds) {
      const accountName = org.accounts.get(accountId);
      if (accountName === undefined || org.excluded.has(accountId)) continue;
      for (const permissionSet of rule.permissionSets) {
        out.push({
          accountId,
          accountName,
          permissionSet,
          maxDurationMinutes: rule.maxDurationMinutes,
          approval: rule.approval,
          rule: rule.name,
        });
      }
    }
  }
  return out;
}

/** Unique (account, permission set) targets with the longest allowed duration. */
export function targets(ents: Entitlement[]) {
  const byKey = new Map<string, { accountId: string; accountName: string; permissionSet: string; maxDurationMinutes: number }>();
  for (const e of ents) {
    const key = `${e.accountId}|${e.permissionSet}`;
    const cur = byKey.get(key);
    if (!cur || e.maxDurationMinutes > cur.maxDurationMinutes) {
      byKey.set(key, {
        accountId: e.accountId,
        accountName: e.accountName,
        permissionSet: e.permissionSet,
        maxDurationMinutes: e.maxDurationMinutes,
      });
    }
  }
  return [...byKey.values()].sort(
    (a, b) => a.accountName.localeCompare(b.accountName) || a.permissionSet.localeCompare(b.permissionSet),
  );
}

export type Resolution =
  | { ok: true; approval: { required: false } }
  | { ok: true; approval: { required: true; approverGroups: string[]; channelId?: string } }
  | { ok: false; reason: string };

/**
 * Picks the approval path for a request. A rule without approval wins when it
 * allows the duration. Otherwise every approval rule that allows the duration
 * contributes its approver groups.
 */
export function resolveRequest(
  ents: Entitlement[],
  accountId: string,
  permissionSet: string,
  durationMinutes: number,
): Resolution {
  if (!Number.isInteger(durationMinutes) || durationMinutes <= 0) {
    return { ok: false, reason: "Duration must be a positive number of minutes." };
  }
  const matching = ents.filter((e) => e.accountId === accountId && e.permissionSet === permissionSet);
  if (matching.length === 0) {
    return { ok: false, reason: "You are not eligible for this account and permission set." };
  }
  const fits = matching.filter((e) => durationMinutes <= e.maxDurationMinutes);
  if (fits.length === 0) {
    const max = Math.max(...matching.map((e) => e.maxDurationMinutes));
    return { ok: false, reason: `Duration exceeds the maximum of ${max} minutes.` };
  }
  if (fits.some((e) => !e.approval.required)) return { ok: true, approval: { required: false } };

  const groups = new Set<string>();
  let channelId: string | undefined;
  for (const e of fits) {
    if (!e.approval.required) continue;
    e.approval.approverGroups.forEach((g) => groups.add(g));
    channelId ??= e.approval.channelId;
  }
  return { ok: true, approval: { required: true, approverGroups: [...groups].sort(), channelId } };
}
