import * as service from "../service.js";
import type { Submission } from "../slack/views.js";

export type WorkerEvent =
  | { type: "populate"; viewId: string; slackUserId: string }
  | { type: "submit"; slackUserId: string; submission: Submission }
  | { type: "action"; action: "approve" | "deny" | "revoke"; requestId: string; slackUserId: string; channel?: string };

export async function handler(event: WorkerEvent) {
  try {
    switch (event.type) {
      case "populate":
        return await service.populateModal(event.viewId, event.slackUserId);
      case "submit":
        return await service.submit(event.slackUserId, event.submission);
      case "action":
        if (event.action === "revoke") return await service.revoke(event.requestId, event.slackUserId, event.channel);
        return await service.decide(event.requestId, event.slackUserId, event.action === "approve", event.channel);
    }
  } catch (e) {
    const channel = event.type === "action" ? event.channel : undefined;
    if (e instanceof service.UserFacingError) {
      await service.tell(event.slackUserId, e.message, channel).catch(() => {});
      return;
    }
    console.error(e);
    await service.tell(event.slackUserId, `Something went wrong: ${(e as Error).message}`, channel).catch(() => {});
    throw e;
  }
}
