import { slackSecrets } from "../runtime/secrets.js";

/** Read methods such as users.info ignore JSON bodies and need form encoding. */
const FORM_METHODS = new Set(["users.info"]);

export async function slack<T = Record<string, unknown>>(method: string, body: Record<string, unknown>): Promise<T> {
  const { botToken } = await slackSecrets();
  const form = FORM_METHODS.has(method);
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${botToken}`,
      "Content-Type": form ? "application/x-www-form-urlencoded" : "application/json; charset=utf-8",
    },
    body: form
      ? new URLSearchParams(Object.entries(body).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]))
      : JSON.stringify(body),
  });
  const json = (await res.json()) as { ok: boolean; error?: string } & T;
  if (!json.ok) throw new Error(`Slack ${method} failed: ${json.error}`);
  return json;
}

export async function emailForSlackUser(slackUserId: string): Promise<string> {
  const r = await slack<{ user: { profile: { email?: string } } }>("users.info", { user: slackUserId });
  const email = r.user.profile.email;
  if (!email) throw new Error("Slack profile has no email. The app needs the users:read.email scope.");
  return email;
}

export const dm = (slackUserId: string, text: string) => slack("chat.postMessage", { channel: slackUserId, text });
