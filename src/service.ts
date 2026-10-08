import { randomUUID } from "node:crypto";
import { StartExecutionCommand, StopExecutionCommand } from "@aws-sdk/client-sfn";
import { sfn } from "./aws/clients.js";
import { userByEmail, type IdcUser } from "./aws/identity.js";
import { orgView } from "./aws/org.js";
import * as ssoApi from "./aws/sso.js";
import * as store from "./aws/store.js";
import { entitlementsFor, resolveRequest, targets } from "./domain/eligibility.js";
import { canApprove, canRevoke, revocable, type AccessRequest } from "./domain/request.js";
import { renderRevocationPolicy } from "./domain/revocation.js";
import { config, env } from "./runtime/config.js";
import { dm, emailForSlackUser, slack } from "./slack/api.js";
import { activeMessage, approvalMessage, messageModal, requestModal, type Submission } from "./slack/views.js";

/** Tokens issued this soon after the revoke are also denied, to cover propagation delay. */
const REVOKE_BUFFER_S = 60;
const REVOCATION_MARGIN_S = 300;

const ic = () => config().identityCenter;
const nowIso = () => new Date().toISOString();

/** An error whose message is safe and useful to show the Slack user. */
export class UserFacingError extends Error {}

async function identify(slackUserId: string): Promise<IdcUser> {
  const email = await emailForSlackUser(slackUserId);
  try {
    return await userByEmail(ic().identityStoreId, email);
  } catch (e) {
    if ((e as Error).name === "ResourceNotFoundException") {
      throw new UserFacingError(`Your Slack email ${email} does not match an AWS Identity Center user.`);
    }
    throw e;
  }
}

async function entitlements(user: IdcUser) {
  const rules = config().eligibility;
  const view = await orgView(rules.flatMap((r) => r.ous ?? []));
  return entitlementsFor(user.groups, rules, view);
}

/** Tells a user something, ephemerally in a channel when one is known. */
async function tell(slackUserId: string, message: string, channel?: string) {
  if (channel) await slack("chat.postEphemeral", { channel, user: slackUserId, text: message });
  else await dm(slackUserId, message);
}

/** Slack failures must never break an access operation. */
async function notify(fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (e) {
    console.error("notification failed", e);
  }
}

async function refreshApprovalMessage(r: AccessRequest) {
  if (!r.approvalChannelId || !r.approvalMessageTs) return;
  await slack("chat.update", { channel: r.approvalChannelId, ts: r.approvalMessageTs, ...approvalMessage(r) });
}

export async function populateModal(viewId: string, slackUserId: string) {
  try {
    const ents = await entitlements(await identify(slackUserId));
    const view = ents.length
      ? requestModal(targets(ents))
      : messageModal("You are not eligible for any temporary access.");
    await slack("views.update", { view_id: viewId, view });
  } catch (e) {
    if (!(e instanceof UserFacingError)) console.error(e);
    const message = e instanceof UserFacingError ? e.message : `Could not load eligibility: ${(e as Error).message}`;
    await slack("views.update", { view_id: viewId, view: messageModal(message) });
  }
}

export { tell };

export async function submit(slackUserId: string, s: Submission) {
  const user = await identify(slackUserId);
  const ents = await entitlements(user);
  const res = resolveRequest(ents, s.accountId, s.permissionSet, s.durationMinutes);
  if (!res.ok) return dm(slackUserId, `Request rejected. ${res.reason}`);

  const open = await store.openRequestsFor(user.userId);
  if (open.some((r) => r.accountId === s.accountId && r.permissionSet === s.permissionSet)) {
    return dm(slackUserId, "Request rejected. You already have an open request for this account and permission set.");
  }
  const psArn = await ssoApi.permissionSetArn(ic().instanceArn, s.permissionSet);
  if (await ssoApi.hasUserAssignment(ic().instanceArn, s.accountId, psArn, user.userId)) {
    return dm(slackUserId, "Request rejected. You already have standing access to this account and permission set.");
  }

  const accountName = ents.find((e) => e.accountId === s.accountId)!.accountName;
  const approval = res.approval;
  const req: AccessRequest = {
    requestId: randomUUID(),
    status: "PENDING",
    requesterUserId: user.userId,
    requesterUserName: user.userName,
    requesterSlackId: slackUserId,
    accountId: s.accountId,
    accountName,
    permissionSet: s.permissionSet,
    durationMinutes: s.durationMinutes,
    justification: s.justification,
    ticket: s.ticket,
    approvalRequired: approval.required,
    approverGroups: approval.required ? approval.approverGroups : [],
    approvalChannelId: (approval.required && approval.channelId) || config().slack.approvalChannelId,
    createdAt: nowIso(),
    history: [{ at: nowIso(), status: "PENDING", by: user.userName, note: "Requested" }],
  };
  await store.createRequest(req);

  // Every request is posted so the channel is a complete record, approval or not.
  const posted = await slack<{ ts: string }>("chat.postMessage", { channel: req.approvalChannelId, ...approvalMessage(req) });
  req.approvalMessageTs = posted.ts;
  await store.setFields(req.requestId, { approvalMessageTs: posted.ts });

  if (!approval.required) {
    const approved = await store.transition(req.requestId, "PENDING", "APPROVED", { by: "policy", note: "Auto-approved" });
    if (approved) await startWorkflow(approved);
    return;
  }
  await dm(slackUserId, `Request submitted for ${accountName} / ${s.permissionSet}. Waiting for approval.`);
}

export async function decide(requestId: string, slackUserId: string, approve: boolean, channel?: string) {
  const req = await store.getRequest(requestId);
  if (!req) return tell(slackUserId, "Request not found.", channel);
  const actor = await identify(slackUserId);
  // A requester may withdraw their own pending request with Deny.
  const cancelling = !approve && req.status === "PENDING" && actor.userId === req.requesterUserId;
  if (!cancelling) {
    const check = canApprove(req, actor.userId, actor.groups);
    if (!check.ok) return tell(slackUserId, check.reason, channel);
  }

  const updated = await store.transition(
    requestId,
    "PENDING",
    approve ? "APPROVED" : "DENIED",
    { by: actor.userName, note: approve ? "Approved" : cancelling ? "Cancelled by requester" : "Denied" },
    { approvedBy: slackUserId },
  );
  if (!updated) return tell(slackUserId, "Someone else already handled this request.", channel);
  if (approve) return startWorkflow(updated);

  await notify(() => refreshApprovalMessage(updated));
  if (!cancelling) {
    await notify(() => dm(updated.requesterSlackId, `Your request for ${updated.accountName} / ${updated.permissionSet} was denied.`));
  }
}

async function startWorkflow(req: AccessRequest) {
  const r = await sfn.send(
    new StartExecutionCommand({
      stateMachineArn: env("STATE_MACHINE_ARN"),
      name: req.requestId,
      input: JSON.stringify({ requestId: req.requestId }),
    }),
  );
  await store.setFields(req.requestId, { executionArn: r.executionArn });
  await notify(() => refreshApprovalMessage(req));
}

export async function revoke(requestId: string, slackUserId: string, channel?: string) {
  const req = await store.getRequest(requestId);
  if (!req) return tell(slackUserId, "Request not found.", channel);
  const actor = await identify(slackUserId);
  const check = canRevoke(req, actor.userId, actor.groups);
  if (!check.ok) return tell(slackUserId, check.reason, channel);

  if (req.executionArn) {
    try {
      await sfn.send(new StopExecutionCommand({ executionArn: req.executionArn, cause: `Revoked by ${actor.userName}` }));
    } catch (e) {
      console.warn("stop execution", e);
    }
  }
  await endAccess(requestId, `Revoked by ${actor.userName}.`, actor.userName);
}

/** Step Functions task: create the assignment and mark the request active. */
export async function grant(requestId: string): Promise<{ requestId: string; endsAt: string }> {
  const req = await store.getRequest(requestId);
  if (!req || req.status !== "APPROVED") return { requestId, endsAt: nowIso() };

  const psArn = await ssoApi.permissionSetArn(ic().instanceArn, req.permissionSet);
  const exists = await ssoApi.hasUserAssignment(ic().instanceArn, req.accountId, psArn, req.requesterUserId);
  if (exists && !req.grantAttempted) {
    throw new Error("User has standing access to this target. Refusing to grant, so expiry cannot remove it.");
  }
  await store.setFields(requestId, { grantAttempted: true });
  if (!exists) await ssoApi.createAssignment(ic().instanceArn, req.accountId, psArn, req.requesterUserId);

  const startedAt = new Date();
  const endsAt = new Date(startedAt.getTime() + req.durationMinutes * 60_000).toISOString();
  const active = await store.transition(
    requestId,
    "APPROVED",
    "ACTIVE",
    { by: "system", note: "Access granted" },
    { startedAt: startedAt.toISOString(), endsAt },
  );
  if (!active) {
    // Revoked while the assignment was being created.
    await removeAccess(req);
    return { requestId, endsAt: nowIso() };
  }
  await notify(() => refreshApprovalMessage(active));
  await notify(() => slack("chat.postMessage", { channel: active.requesterSlackId, ...activeMessage(active, ic().accessPortalUrl) }));
  return { requestId, endsAt };
}

/**
 * Removes access and cuts off issued credentials. Safe to call more than once
 * and from both the workflow and a manual revoke.
 */
export async function endAccess(requestId: string, note: string, by: string) {
  const req = await store.getRequest(requestId);
  if (!req || !revocable.includes(req.status)) return;

  // Ending an approved request first blocks a concurrent grant from activating it.
  const ended =
    req.status === "APPROVED" ? await store.transition(requestId, "APPROVED", "ENDED", { by, note }) : undefined;

  if (req.status === "ACTIVE" || req.grantAttempted) await removeAccess(req);

  const final = ended ?? (await store.transition(requestId, "ACTIVE", "ENDED", { by, note }));
  if (!final) return;
  await notify(() => refreshApprovalMessage(final));
  await notify(() => dm(final.requesterSlackId, `Your access to ${final.accountName} / ${final.permissionSet} has ended. ${note}`));
}

/** Step Functions catch handler. */
export async function fail(requestId: string, error: string) {
  const req = await store.getRequest(requestId);
  if (!req || !revocable.includes(req.status)) return;
  if (req.grantAttempted) await removeAccess(req);
  const failed = await store.transition(requestId, req.status, "FAILED", { by: "system", note: error.slice(0, 500) });
  if (!failed) return;
  await notify(() => refreshApprovalMessage(failed));
  await notify(() => dm(failed.requesterSlackId, `Your request for ${failed.accountName} failed: ${error.slice(0, 300)}`));
}

async function removeAccess(req: AccessRequest) {
  const psArn = await ssoApi.permissionSetArn(ic().instanceArn, req.permissionSet);
  await ssoApi.deleteAssignment(ic().instanceArn, req.accountId, psArn, req.requesterUserId);

  const revokedAtS = Math.floor(Date.now() / 1000) + REVOKE_BUFFER_S;
  await store.addRevocation(psArn, req.requestId, {
    userName: req.requesterUserName,
    accountId: req.accountId,
    revokedAt: new Date(revokedAtS * 1000).toISOString(),
    expiresAt: revokedAtS + config().sessionDurationMinutes * 60 + REVOCATION_MARGIN_S,
  });
  await syncRevocationPolicy(psArn);
}

/**
 * Writes the policy, then re-reads the entries. If another writer added one in
 * between, write again. The last writer always sees every committed entry.
 */
async function syncRevocationPolicy(psArn: string) {
  for (let i = 0; i < 5; i++) {
    const now = Math.floor(Date.now() / 1000);
    const doc = renderRevocationPolicy(await store.revocationsFor(psArn), now);
    await ssoApi.applyInlinePolicy(ic().instanceArn, psArn, doc);
    if (renderRevocationPolicy(await store.revocationsFor(psArn), now) === doc) return;
  }
  throw new Error(`Revocation policy for ${psArn} did not settle after 5 attempts.`);
}
