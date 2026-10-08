import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { AccessRequest, HistoryEntry, Status } from "../domain/request.js";
import { canTransition } from "../domain/request.js";
import type { RevocationEntry } from "../domain/revocation.js";
import { env } from "../runtime/config.js";
import { ddb } from "./clients.js";

const requests = () => env("REQUESTS_TABLE");
const revocations = () => env("REVOCATIONS_TABLE");

export async function getRequest(requestId: string): Promise<AccessRequest | undefined> {
  const r = await ddb.send(new GetCommand({ TableName: requests(), Key: { requestId }, ConsistentRead: true }));
  return r.Item as AccessRequest | undefined;
}

export async function createRequest(req: AccessRequest) {
  await ddb.send(
    new PutCommand({ TableName: requests(), Item: req, ConditionExpression: "attribute_not_exists(requestId)" }),
  );
}

/** Open requests for a user. Used to block overlapping grants on one target. */
export async function openRequestsFor(userId: string): Promise<AccessRequest[]> {
  const r = await ddb.send(
    new QueryCommand({
      TableName: requests(),
      IndexName: "byRequester",
      KeyConditionExpression: "requesterUserId = :u",
      FilterExpression: "#s IN (:p, :a, :ac)",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: { ":u": userId, ":p": "PENDING", ":a": "APPROVED", ":ac": "ACTIVE" },
    }),
  );
  return (r.Items ?? []) as AccessRequest[];
}

/**
 * Moves a request from one status to another. Returns the updated request,
 * or undefined when another actor already moved it.
 */
export async function transition(
  requestId: string,
  from: Status,
  to: Status,
  entry: Omit<HistoryEntry, "status" | "at">,
  patch: Partial<AccessRequest> = {},
): Promise<AccessRequest | undefined> {
  if (!canTransition(from, to)) throw new Error(`Illegal transition ${from} -> ${to}`);
  const names: Record<string, string> = { "#s": "status", "#h": "history" };
  const values: Record<string, unknown> = {
    ":from": from,
    ":to": to,
    ":h": [{ ...entry, status: to, at: new Date().toISOString() }],
  };
  const sets = ["#s = :to", "#h = list_append(#h, :h)"];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    names[`#${k}`] = k;
    values[`:${k}`] = v;
    sets.push(`#${k} = :${k}`);
  }
  try {
    const r = await ddb.send(
      new UpdateCommand({
        TableName: requests(),
        Key: { requestId },
        UpdateExpression: `SET ${sets.join(", ")}`,
        ConditionExpression: "#s = :from",
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ReturnValues: "ALL_NEW",
      }),
    );
    return r.Attributes as AccessRequest;
  } catch (e) {
    if (e instanceof ConditionalCheckFailedException) return undefined;
    throw e;
  }
}

export async function setFields(requestId: string, patch: Partial<AccessRequest>) {
  const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return;
  await ddb.send(
    new UpdateCommand({
      TableName: requests(),
      Key: { requestId },
      UpdateExpression: `SET ${entries.map(([k]) => `#${k} = :${k}`).join(", ")}`,
      ExpressionAttributeNames: Object.fromEntries(entries.map(([k]) => [`#${k}`, k])),
      ExpressionAttributeValues: Object.fromEntries(entries.map(([k, v]) => [`:${k}`, v])),
    }),
  );
}

export async function addRevocation(permissionSetArn: string, requestId: string, e: RevocationEntry) {
  await ddb.send(
    new PutCommand({
      TableName: revocations(),
      Item: { permissionSetArn, entryId: `${e.userName}#${e.accountId}#${requestId}`, ...e },
    }),
  );
}

export async function revocationsFor(permissionSetArn: string): Promise<RevocationEntry[]> {
  const out: RevocationEntry[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const r = await ddb.send(
      new QueryCommand({
        TableName: revocations(),
        KeyConditionExpression: "permissionSetArn = :p",
        ExpressionAttributeValues: { ":p": permissionSetArn },
        ConsistentRead: true,
        ExclusiveStartKey: start,
      }),
    );
    out.push(...((r.Items ?? []) as RevocationEntry[]));
    start = r.LastEvaluatedKey;
  } while (start);
  return out;
}
