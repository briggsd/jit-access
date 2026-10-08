import { describe, expect, it } from "vitest";
import { escapeStringLike, isOwnedPolicy, renderRevocationPolicy } from "../src/domain/revocation.js";

const now = 1_000_000;

describe("renderRevocationPolicy", () => {
  it("returns null when nothing is active", () => {
    expect(renderRevocationPolicy([], now)).toBeNull();
    expect(renderRevocationPolicy([{ userName: "a", accountId: "1", revokedAt: "x", expiresAt: now }], now)).toBeNull();
  });

  it("keeps the latest revocation per user and account", () => {
    const doc = JSON.parse(
      renderRevocationPolicy(
        [
          { userName: "alice", accountId: "111", revokedAt: "2026-10-07T10:00:00Z", expiresAt: now + 10 },
          { userName: "alice", accountId: "111", revokedAt: "2026-10-07T11:00:00Z", expiresAt: now + 10 },
          { userName: "alice", accountId: "222", revokedAt: "2026-10-07T09:00:00Z", expiresAt: now + 10 },
        ],
        now,
      )!,
    );
    expect(doc.Statement).toHaveLength(2);
    expect(doc.Statement[0]).toEqual({
      Sid: "JitRevoke0",
      Effect: "Deny",
      Action: "*",
      Resource: "*",
      Condition: {
        StringLike: { "aws:userid": "*:alice" },
        StringEquals: { "aws:PrincipalAccount": "111" },
        DateLessThan: { "aws:TokenIssueTime": "2026-10-07T11:00:00Z" },
      },
    });
  });

  it("is deterministic regardless of input order", () => {
    const a = { userName: "a", accountId: "1", revokedAt: "t", expiresAt: now + 1 };
    const b = { userName: "b", accountId: "1", revokedAt: "t", expiresAt: now + 1 };
    expect(renderRevocationPolicy([a, b], now)).toBe(renderRevocationPolicy([b, a], now));
  });

  it("throws past the inline policy size limit", () => {
    const many = Array.from({ length: 400 }, (_, i) => ({ userName: `user${i}@example.com`, accountId: "111111111111", revokedAt: "2026-10-07T10:00:00Z", expiresAt: now + 1 }));
    expect(() => renderRevocationPolicy(many, now)).toThrow(/limit/);
  });
});

describe("escapeStringLike", () => {
  it("escapes wildcards", () => {
    expect(escapeStringLike("a*b?c")).toBe("a${*}b${?}c");
  });
});

describe("isOwnedPolicy", () => {
  it("accepts empty and app-written policies only", () => {
    expect(isOwnedPolicy(undefined)).toBe(true);
    expect(isOwnedPolicy("")).toBe(true);
    expect(isOwnedPolicy(renderRevocationPolicy([{ userName: "a", accountId: "1", revokedAt: "t", expiresAt: now + 1 }], now)!)).toBe(true);
    expect(isOwnedPolicy(JSON.stringify({ Statement: [{ Sid: "Custom", Effect: "Allow" }] }))).toBe(false);
    expect(isOwnedPolicy(JSON.stringify({ Statement: { Effect: "Allow" } }))).toBe(false);
  });
});
