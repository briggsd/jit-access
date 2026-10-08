export type Status =
  | "PENDING"
  | "APPROVED"
  | "DENIED"
  | "ACTIVE"
  | "ENDED"
  | "FAILED";

export const transitions: Record<Status, Status[]> = {
  PENDING: ["APPROVED", "DENIED"],
  APPROVED: ["ACTIVE", "FAILED", "ENDED"],
  ACTIVE: ["ENDED", "FAILED"],
  DENIED: [],
  ENDED: [],
  FAILED: [],
};

/** Statuses from which a revoke must remove access or stop the workflow. */
export const revocable: Status[] = ["APPROVED", "ACTIVE"];

export interface HistoryEntry {
  at: string;
  status: Status;
  by: string;
  note?: string;
}

export interface AccessRequest {
  requestId: string;
  status: Status;
  requesterUserId: string;
  requesterUserName: string;
  requesterSlackId: string;
  accountId: string;
  accountName: string;
  permissionSet: string;
  durationMinutes: number;
  justification: string;
  ticket?: string;
  approvalRequired: boolean;
  approverGroups: string[];
  approvalChannelId?: string;
  approvalMessageTs?: string;
  approvedBy?: string;
  startedAt?: string;
  endsAt?: string;
  executionArn?: string;
  /** Set before the grant creates an assignment, so retries can tell it apart from standing access. */
  grantAttempted?: boolean;
  createdAt: string;
  history: HistoryEntry[];
}

export function canTransition(from: Status, to: Status): boolean {
  return transitions[from].includes(to);
}

export type Decision = { ok: true } | { ok: false; reason: string };

export function canApprove(
  req: Pick<AccessRequest, "status" | "requesterUserId" | "approverGroups">,
  actorUserId: string,
  actorGroups: Set<string>,
): Decision {
  if (req.status !== "PENDING") return { ok: false, reason: `Request is already ${req.status}.` };
  if (actorUserId === req.requesterUserId) return { ok: false, reason: "You cannot approve your own request." };
  if (!req.approverGroups.some((g) => actorGroups.has(g))) {
    return { ok: false, reason: "You are not in an approver group for this request." };
  }
  return { ok: true };
}

export function canRevoke(
  req: Pick<AccessRequest, "status" | "requesterUserId" | "approverGroups">,
  actorUserId: string,
  actorGroups: Set<string>,
): Decision {
  if (!revocable.includes(req.status)) return { ok: false, reason: `Request is ${req.status}.` };
  if (actorUserId === req.requesterUserId) return { ok: true };
  if (req.approverGroups.some((g) => actorGroups.has(g))) return { ok: true };
  return { ok: false, reason: "Only the requester or an approver can revoke." };
}
