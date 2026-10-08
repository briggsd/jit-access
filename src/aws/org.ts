import {
  DescribeOrganizationCommand,
  paginateListAccounts,
  paginateListAccountsForParent,
  paginateListOrganizationalUnitsForParent,
} from "@aws-sdk/client-organizations";
import type { OrgView } from "../domain/eligibility.js";
import { org } from "./clients.js";

const TTL_MS = 5 * 60_000;
let cached: { at: number; key: string; view: OrgView } | undefined;

export async function orgView(ouIds: string[]): Promise<OrgView> {
  const key = [...ouIds].sort().join(",");
  if (cached && cached.key === key && Date.now() - cached.at < TTL_MS) return cached.view;

  const accounts = new Map<string, string>();
  for await (const page of paginateListAccounts({ client: org }, {})) {
    for (const a of page.Accounts ?? []) {
      const active = a.State ? a.State === "ACTIVE" : a.Status === "ACTIVE";
      if (active) accounts.set(a.Id!, a.Name ?? a.Id!);
    }
  }
  const { Organization } = await org.send(new DescribeOrganizationCommand({}));
  const accountsByOu = new Map<string, string[]>();
  for (const ou of new Set(ouIds)) accountsByOu.set(ou, await accountsUnder(ou));

  const view: OrgView = {
    accounts,
    accountsByOu,
    // A delegated administrator cannot manage assignments in the management account.
    excluded: new Set([Organization!.MasterAccountId!]),
  };
  cached = { at: Date.now(), key, view };
  return view;
}

async function accountsUnder(parentId: string): Promise<string[]> {
  const out: string[] = [];
  for await (const page of paginateListAccountsForParent({ client: org }, { ParentId: parentId })) {
    for (const a of page.Accounts ?? []) out.push(a.Id!);
  }
  for await (const page of paginateListOrganizationalUnitsForParent({ client: org }, { ParentId: parentId })) {
    for (const ou of page.OrganizationalUnits ?? []) out.push(...(await accountsUnder(ou.Id!)));
  }
  return out;
}
