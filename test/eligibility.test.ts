import { describe, expect, it } from "vitest";
import type { EligibilityRule } from "../src/domain/config.js";
import { entitlementsFor, resolveRequest, targets, type OrgView } from "../src/domain/eligibility.js";

const org: OrgView = {
  accounts: new Map([
    ["111", "dev-a"],
    ["222", "dev-b"],
    ["333", "prod"],
    ["999", "management"],
  ]),
  accountsByOu: new Map([
    ["ou-dev", ["111", "222"]],
    ["ou-root", ["111", "222", "333", "999"]],
  ]),
  excluded: new Set(["999"]),
};

const rules: EligibilityRule[] = [
  { name: "dev-ro", groups: ["Eng"], ous: ["ou-dev"], permissionSets: ["RO"], maxDurationMinutes: 240, approval: { required: false } },
  { name: "prod-admin", groups: ["Eng"], accounts: ["333"], permissionSets: ["Admin"], maxDurationMinutes: 60, approval: { required: true, approverGroups: ["Leads"] } },
  { name: "prod-admin-long", groups: ["SRE"], accounts: ["333"], permissionSets: ["Admin"], maxDurationMinutes: 480, approval: { required: true, approverGroups: ["Directors"], channelId: "CSRE" } },
  { name: "root-all", groups: ["Ops"], ous: ["ou-root"], permissionSets: ["RO"], maxDurationMinutes: 30, approval: { required: true, approverGroups: ["Leads"] } },
];

describe("entitlementsFor", () => {
  it("expands OUs and filters by group", () => {
    const e = entitlementsFor(new Set(["Eng"]), rules, org);
    expect(e.map((x) => `${x.accountId}/${x.permissionSet}`).sort()).toEqual(["111/RO", "222/RO", "333/Admin"]);
  });

  it("never includes excluded or unknown accounts", () => {
    const e = entitlementsFor(new Set(["Ops"]), rules, org);
    expect(e.map((x) => x.accountId).sort()).toEqual(["111", "222", "333"]);
    const unknown = entitlementsFor(new Set(["X"]), [{ ...rules[0], groups: ["X"], ous: [], accounts: ["404"] }], org);
    expect(unknown).toEqual([]);
  });

  it("returns nothing for a user in no group", () => {
    expect(entitlementsFor(new Set(), rules, org)).toEqual([]);
  });
});

describe("targets", () => {
  it("dedupes and keeps the longest duration", () => {
    const e = entitlementsFor(new Set(["Eng", "SRE"]), rules, org);
    const prod = targets(e).find((t) => t.accountId === "333")!;
    expect(prod.maxDurationMinutes).toBe(480);
    expect(targets(e)).toHaveLength(3);
  });
});

describe("resolveRequest", () => {
  const eng = entitlementsFor(new Set(["Eng"]), rules, org);
  const both = entitlementsFor(new Set(["Eng", "SRE"]), rules, org);

  it("auto-approves when a no-approval rule fits", () => {
    expect(resolveRequest(eng, "111", "RO", 240)).toEqual({ ok: true, approval: { required: false } });
  });

  it("rejects durations over the maximum", () => {
    const r = resolveRequest(eng, "111", "RO", 241);
    expect(r).toEqual({ ok: false, reason: "Duration exceeds the maximum of 240 minutes." });
  });

  it("rejects ineligible targets and bad durations", () => {
    expect(resolveRequest(eng, "111", "Admin", 30).ok).toBe(false);
    expect(resolveRequest(eng, "111", "RO", 0).ok).toBe(false);
    expect(resolveRequest(eng, "111", "RO", 1.5).ok).toBe(false);
  });

  it("unions approvers of every fitting rule", () => {
    expect(resolveRequest(both, "333", "Admin", 60)).toEqual({
      ok: true,
      approval: { required: true, approverGroups: ["Directors", "Leads"], channelId: "CSRE" },
    });
  });

  it("only counts rules that allow the duration", () => {
    expect(resolveRequest(both, "333", "Admin", 120)).toEqual({
      ok: true,
      approval: { required: true, approverGroups: ["Directors"], channelId: "CSRE" },
    });
  });

  it("requires approval when the no-approval rule is too short", () => {
    const mixed = entitlementsFor(new Set(["Eng", "Ops"]), rules, org);
    expect(resolveRequest(mixed, "111", "RO", 200).ok && (resolveRequest(mixed, "111", "RO", 200) as any).approval.required).toBe(false);
    const opsOnly = entitlementsFor(new Set(["Ops"]), rules, org);
    expect(resolveRequest(opsOnly, "111", "RO", 30)).toMatchObject({ ok: true, approval: { required: true } });
  });
});
