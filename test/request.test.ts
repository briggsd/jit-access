import { describe, expect, it } from "vitest";
import { canApprove, canRevoke, canTransition } from "../src/domain/request.js";

const req = { status: "PENDING" as const, requesterUserId: "u-req", approverGroups: ["Leads"] };

describe("transitions", () => {
  it("allows the lifecycle and blocks terminal exits", () => {
    expect(canTransition("PENDING", "APPROVED")).toBe(true);
    expect(canTransition("APPROVED", "ACTIVE")).toBe(true);
    expect(canTransition("ACTIVE", "ENDED")).toBe(true);
    expect(canTransition("ENDED", "ACTIVE")).toBe(false);
    expect(canTransition("DENIED", "APPROVED")).toBe(false);
    expect(canTransition("PENDING", "ACTIVE")).toBe(false);
  });
});

describe("canApprove", () => {
  it("allows an approver group member", () => {
    expect(canApprove(req, "u-lead", new Set(["Leads"]))).toEqual({ ok: true });
  });
  it("blocks self-approval even for approvers", () => {
    expect(canApprove(req, "u-req", new Set(["Leads"])).ok).toBe(false);
  });
  it("blocks non-approvers and non-pending requests", () => {
    expect(canApprove(req, "u-x", new Set(["Eng"])).ok).toBe(false);
    expect(canApprove({ ...req, status: "APPROVED" }, "u-lead", new Set(["Leads"])).ok).toBe(false);
  });
});

describe("canRevoke", () => {
  const active = { ...req, status: "ACTIVE" as const };
  it("allows the requester and approvers", () => {
    expect(canRevoke(active, "u-req", new Set()).ok).toBe(true);
    expect(canRevoke(active, "u-lead", new Set(["Leads"])).ok).toBe(true);
  });
  it("blocks others and finished requests", () => {
    expect(canRevoke(active, "u-x", new Set(["Eng"])).ok).toBe(false);
    expect(canRevoke({ ...active, status: "ENDED" }, "u-req", new Set()).ok).toBe(false);
    expect(canRevoke({ ...active, status: "PENDING" }, "u-req", new Set()).ok).toBe(false);
  });
});
