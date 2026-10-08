import type { AccessRequest } from "../domain/request.js";

export const REQUEST_CALLBACK = "jit_request";
export const DURATIONS = [15, 30, 60, 120, 240, 480, 720];
const MAX_OPTIONS = 100;

const text = (t: string) => ({ type: "plain_text" as const, text: t.slice(0, 75), emoji: false });
const md = (t: string) => ({ type: "section", text: { type: "mrkdwn", text: t } });

export function loadingModal() {
  return {
    type: "modal",
    callback_id: REQUEST_CALLBACK,
    title: text("Request AWS access"),
    blocks: [md("Loading your eligible accounts...")],
  };
}

export function messageModal(message: string) {
  return { type: "modal", title: text("Request AWS access"), close: text("Close"), blocks: [md(message)] };
}

export interface TargetOption {
  accountId: string;
  accountName: string;
  permissionSet: string;
  maxDurationMinutes: number;
}

export function requestModal(targets: TargetOption[]) {
  const shown = targets.slice(0, MAX_OPTIONS);
  const blocks: unknown[] = [
    {
      type: "input",
      block_id: "target",
      label: text("Account and permission set"),
      element: {
        type: "static_select",
        action_id: "v",
        options: shown.map((t) => ({
          text: text(`${t.accountName} (${t.accountId}) / ${t.permissionSet}`),
          value: `${t.accountId}|${t.permissionSet}`,
        })),
      },
    },
    {
      type: "input",
      block_id: "duration",
      label: text("Duration"),
      element: {
        type: "static_select",
        action_id: "v",
        options: DURATIONS.map((m) => ({ text: text(formatMinutes(m)), value: String(m) })),
      },
    },
    {
      type: "input",
      block_id: "justification",
      label: text("Justification"),
      element: { type: "plain_text_input", action_id: "v", multiline: true, min_length: 10, max_length: 1000 },
    },
    {
      type: "input",
      block_id: "ticket",
      optional: true,
      label: text("Ticket"),
      element: { type: "plain_text_input", action_id: "v", max_length: 100 },
    },
  ];
  if (targets.length > MAX_OPTIONS) {
    blocks.push(md(`_Showing the first ${MAX_OPTIONS} of ${targets.length} targets._`));
  }
  return {
    type: "modal",
    callback_id: REQUEST_CALLBACK,
    title: text("Request AWS access"),
    submit: text("Submit"),
    close: text("Cancel"),
    blocks,
  };
}

export interface Submission {
  accountId: string;
  permissionSet: string;
  durationMinutes: number;
  justification: string;
  ticket?: string;
}

type ViewState = Record<string, Record<string, { selected_option?: { value: string }; value?: string | null }>>;

export function parseSubmission(values: ViewState): Submission {
  const [accountId, permissionSet] = values.target.v.selected_option!.value.split("|");
  return {
    accountId,
    permissionSet,
    durationMinutes: Number(values.duration.v.selected_option!.value),
    justification: values.justification.v.value ?? "",
    ticket: values.ticket?.v.value || undefined,
  };
}

export function formatMinutes(m: number): string {
  if (m < 60) return `${m} minutes`;
  const h = m / 60;
  return Number.isInteger(h) ? `${h} hour${h === 1 ? "" : "s"}` : `${m} minutes`;
}

/** Slack mrkdwn treats &, <, > as control characters. */
export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function summary(r: AccessRequest) {
  const lines = [
    `*Requester:* <@${r.requesterSlackId}> (${esc(r.requesterUserName)})`,
    `*Account:* ${esc(r.accountName)} (${r.accountId})`,
    `*Permission set:* ${esc(r.permissionSet)}`,
    `*Duration:* ${formatMinutes(r.durationMinutes)}`,
    `*Justification:* ${esc(r.justification)}`,
  ];
  if (r.ticket) lines.push(`*Ticket:* ${esc(r.ticket)}`);
  return lines.join("\n");
}

const button = (label: string, actionId: string, requestId: string, style?: "primary" | "danger") => ({
  type: "button",
  text: text(label),
  action_id: actionId,
  value: requestId,
  ...(style ? { style } : {}),
});

/** The approval channel message. Buttons follow the request's status. */
export function approvalMessage(r: AccessRequest) {
  const statusLine: Record<AccessRequest["status"], string> = {
    PENDING: `:hourglass: Waiting for approval from ${r.approverGroups.map(esc).join(", ")}`,
    APPROVED: `:white_check_mark: ${approver(r)}. Granting access...`,
    ACTIVE: `:unlock: Active until <!date^${epoch(r.endsAt)}^{date_short_pretty} {time}|${r.endsAt}>`,
    DENIED: r.approvedBy === r.requesterSlackId ? ":leftwards_arrow_with_hook: Cancelled by requester" : `:no_entry: Denied by <@${r.approvedBy}>`,
    ENDED: `:lock: Ended. ${esc(r.history.at(-1)?.note ?? "")}`,
    FAILED: `:x: Failed. ${esc(r.history.at(-1)?.note ?? "")}`,
  };
  const actions =
    r.status === "PENDING"
      ? [button("Approve", "approve", r.requestId, "primary"), button("Deny", "deny", r.requestId, "danger")]
      : r.status === "APPROVED" || r.status === "ACTIVE"
        ? [button("Revoke", "revoke", r.requestId, "danger")]
        : [];
  const blocks: unknown[] = [md(`*AWS access request* \`${r.requestId}\``), md(summary(r)), md(statusLine[r.status])];
  if (actions.length) blocks.push({ type: "actions", elements: actions });
  return { text: `AWS access request from ${r.requesterUserName}: ${r.status}`, blocks };
}

/** The requester's DM after access becomes active. */
export function activeMessage(r: AccessRequest, portalUrl?: string) {
  const where = portalUrl ? `Open it from the <${portalUrl}|access portal>.` : "Open it from the access portal.";
  return {
    text: `Your access to ${r.accountName} is active.`,
    blocks: [
      md(
        `:unlock: *${esc(r.permissionSet)}* on *${esc(r.accountName)}* is active until <!date^${epoch(r.endsAt)}^{time}|${r.endsAt}>. ${where}`,
      ),
      { type: "actions", elements: [button("Revoke now", "revoke", r.requestId, "danger")] },
    ],
  };
}

const approver = (r: AccessRequest) => (r.approvedBy ? `Approved by <@${r.approvedBy}>` : "Auto-approved by policy");
const epoch = (iso?: string) => (iso ? Math.floor(Date.parse(iso) / 1000) : 0);
