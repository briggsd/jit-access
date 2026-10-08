import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { InvokeCommand } from "@aws-sdk/client-lambda";
import { lambda } from "../aws/clients.js";
import { env } from "../runtime/config.js";
import { slackSecrets } from "../runtime/secrets.js";
import { slack } from "../slack/api.js";
import { verifySlackSignature } from "../slack/verify.js";
import { REQUEST_CALLBACK, loadingModal, parseSubmission } from "../slack/views.js";
import type { WorkerEvent } from "./worker.js";

const ok = (body?: unknown): APIGatewayProxyResultV2 => ({
  statusCode: 200,
  headers: { "Content-Type": "application/json" },
  body: body === undefined ? "" : JSON.stringify(body),
});

/** Slack needs an answer within 3 seconds, so slow work goes to the worker. */
async function dispatch(event: WorkerEvent) {
  await lambda.send(
    new InvokeCommand({
      FunctionName: env("WORKER_FUNCTION"),
      InvocationType: "Event",
      Payload: Buffer.from(JSON.stringify(event)),
    }),
  );
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const raw = event.isBase64Encoded ? Buffer.from(event.body ?? "", "base64").toString("utf8") : (event.body ?? "");
  const { signingSecret } = await slackSecrets();
  if (!verifySlackSignature(signingSecret, event.headers["x-slack-request-timestamp"], event.headers["x-slack-signature"], raw)) {
    return { statusCode: 401, body: "invalid signature" };
  }
  // Slack retries when the first answer is slow. The first delivery already dispatched the work.
  if (event.headers["x-slack-retry-num"]) return ok();
  const form = new URLSearchParams(raw);

  if (form.get("command")) {
    const opened = await slack<{ view: { id: string } }>("views.open", {
      trigger_id: form.get("trigger_id"),
      view: loadingModal(),
    });
    await dispatch({ type: "populate", viewId: opened.view.id, slackUserId: form.get("user_id")! });
    return ok();
  }

  const payload = JSON.parse(form.get("payload") ?? "{}");
  if (payload.type === "view_submission" && payload.view?.callback_id === REQUEST_CALLBACK) {
    await dispatch({ type: "submit", slackUserId: payload.user.id, submission: parseSubmission(payload.view.state.values) });
    return ok({ response_action: "clear" });
  }
  if (payload.type === "block_actions") {
    const action = payload.actions?.[0];
    if (["approve", "deny", "revoke"].includes(action?.action_id)) {
      await dispatch({
        type: "action",
        action: action.action_id,
        requestId: action.value,
        slackUserId: payload.user.id,
        channel: payload.channel?.id,
      });
    }
  }
  return ok();
}
