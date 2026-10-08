import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifySlackSignature } from "../src/slack/verify.js";
import { approvalMessage, esc, formatMinutes, parseSubmission } from "../src/slack/views.js";

const secret = "s3cret";
const sign = (ts: string, body: string) => "v0=" + createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex");

describe("verifySlackSignature", () => {
  const ts = "1700000000";
  it("accepts a valid signature", () => {
    expect(verifySlackSignature(secret, ts, sign(ts, "a=1"), "a=1", 1700000010)).toBe(true);
  });
  it("rejects tampered bodies, stale timestamps, and missing headers", () => {
    expect(verifySlackSignature(secret, ts, sign(ts, "a=1"), "a=2", 1700000010)).toBe(false);
    expect(verifySlackSignature(secret, ts, sign(ts, "a=1"), "a=1", 1700000400)).toBe(false);
    expect(verifySlackSignature(secret, undefined, sign(ts, "a=1"), "a=1", 1700000010)).toBe(false);
    expect(verifySlackSignature(secret, ts, "v0=short", "a=1", 1700000010)).toBe(false);
  });
});

describe("views", () => {
  it("parses a modal submission", () => {
    expect(
      parseSubmission({
        target: { v: { selected_option: { value: "111|JitAdmin" } } },
        duration: { v: { selected_option: { value: "60" } } },
        justification: { v: { value: "incident 42 debugging" } },
        ticket: { v: { value: null } },
      }),
    ).toEqual({ accountId: "111", permissionSet: "JitAdmin", durationMinutes: 60, justification: "incident 42 debugging", ticket: undefined });
  });

  it("formats durations and escapes mrkdwn", () => {
    expect(formatMinutes(30)).toBe("30 minutes");
    expect(formatMinutes(60)).toBe("1 hour");
    expect(formatMinutes(480)).toBe("8 hours");
    expect(esc("<@U1> & <!channel>")).toBe("&lt;@U1&gt; &amp; &lt;!channel&gt;");
  });

  it("shows buttons that match the status", () => {
    const base = {
      requestId: "r1", requesterUserId: "u", requesterUserName: "alice", requesterSlackId: "U1",
      accountId: "111", accountName: "prod", permissionSet: "JitAdmin", durationMinutes: 60,
      justification: "<!channel> fix", approvalRequired: true, approverGroups: ["Leads"],
      createdAt: "t", history: [],
    };
    const ids = (s: string) =>
      (approvalMessage({ ...base, status: s as any }).blocks.at(-1) as any).elements?.map((e: any) => e.action_id);
    expect(ids("PENDING")).toEqual(["approve", "deny"]);
    expect(ids("ACTIVE")).toEqual(["revoke"]);
    expect(ids("ENDED")).toBeUndefined();
    expect(JSON.stringify(approvalMessage({ ...base, status: "PENDING" }))).not.toContain("<!channel>");
  });
});
