export interface RevocationEntry {
  userName: string;
  accountId: string;
  /** ISO timestamp. Credentials issued before this are denied. */
  revokedAt: string;
  /** Epoch seconds after which every affected credential has expired. */
  expiresAt: number;
}

/** Inline policy limit for a permission set. */
export const MAX_INLINE_POLICY_CHARS = 32_768;
export const SID_PREFIX = "JitRevoke";

/** StringLike treats * and ? as wildcards. Escape them in literal values. */
export function escapeStringLike(value: string): string {
  return value.replace(/[*?]/g, (c) => "${" + c + "}");
}

/**
 * Renders the deny policy that cuts off credentials issued before a revocation.
 * Identity Center role sessions are named after the user name, so aws:userid
 * ends with ":<userName>". The account condition keeps a revocation from
 * touching the same user's sessions in other accounts. Returns null when no
 * entry is still active.
 */
export function renderRevocationPolicy(entries: RevocationEntry[], nowEpoch: number): string | null {
  const latest = new Map<string, RevocationEntry>();
  for (const e of entries) {
    if (e.expiresAt <= nowEpoch) continue;
    const key = `${e.userName}\n${e.accountId}`;
    const cur = latest.get(key);
    if (!cur || e.revokedAt > cur.revokedAt) latest.set(key, e);
  }
  if (latest.size === 0) return null;

  const statements = [...latest.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, e], i) => ({
      Sid: `${SID_PREFIX}${i}`,
      Effect: "Deny",
      Action: "*",
      Resource: "*",
      Condition: {
        StringLike: { "aws:userid": `*:${escapeStringLike(e.userName)}` },
        StringEquals: { "aws:PrincipalAccount": e.accountId },
        DateLessThan: { "aws:TokenIssueTime": e.revokedAt },
      },
    }));
  const doc = JSON.stringify({ Version: "2012-10-17", Statement: statements });
  if (doc.length > MAX_INLINE_POLICY_CHARS) {
    throw new Error(`Revocation policy is ${doc.length} chars, over the ${MAX_INLINE_POLICY_CHARS} limit.`);
  }
  return doc;
}

/** True when an inline policy is empty or was written by this app. */
export function isOwnedPolicy(doc: string | undefined): boolean {
  if (!doc) return true;
  const parsed = JSON.parse(doc) as { Statement?: { Sid?: string }[] | { Sid?: string } };
  const stmts = Array.isArray(parsed.Statement) ? parsed.Statement : parsed.Statement ? [parsed.Statement] : [];
  return stmts.every((s) => s.Sid?.startsWith(SID_PREFIX));
}
