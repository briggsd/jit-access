import { GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { secrets } from "../aws/clients.js";
import { env } from "./config.js";

export interface SlackSecrets {
  botToken: string;
  signingSecret: string;
}

let cached: SlackSecrets | undefined;

export async function slackSecrets(): Promise<SlackSecrets> {
  if (cached) return cached;
  const r = await secrets.send(new GetSecretValueCommand({ SecretId: env("SLACK_SECRET_ARN") }));
  const parsed = JSON.parse(r.SecretString ?? "{}") as Partial<SlackSecrets>;
  if (!parsed.botToken || !parsed.signingSecret) {
    throw new Error("Slack secret must contain botToken and signingSecret.");
  }
  cached = parsed as SlackSecrets;
  return cached;
}
