import {
  ConflictException,
  CreateAccountAssignmentCommand,
  DeleteAccountAssignmentCommand,
  DeleteInlinePolicyFromPermissionSetCommand,
  DescribeAccountAssignmentCreationStatusCommand,
  DescribeAccountAssignmentDeletionStatusCommand,
  DescribePermissionSetCommand,
  DescribePermissionSetProvisioningStatusCommand,
  GetInlinePolicyForPermissionSetCommand,
  ListTagsForResourceCommand,
  PutInlinePolicyToPermissionSetCommand,
  ProvisionPermissionSetCommand,
  ThrottlingException,
  paginateListAccountAssignments,
  paginateListPermissionSets,
} from "@aws-sdk/client-sso-admin";
import { isOwnedPolicy } from "../domain/revocation.js";
import { sso } from "./clients.js";

export const MANAGED_TAG = { key: "jit:managed", value: "true" };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let arnByName: Map<string, string> | undefined;

/** Resolves a permission set name and refuses any set not tagged for JIT use. */
export async function permissionSetArn(instanceArn: string, name: string): Promise<string> {
  if (!arnByName) {
    const m = new Map<string, string>();
    for await (const page of paginateListPermissionSets({ client: sso }, { InstanceArn: instanceArn })) {
      for (const arn of page.PermissionSets ?? []) {
        const d = await sso.send(new DescribePermissionSetCommand({ InstanceArn: instanceArn, PermissionSetArn: arn }));
        m.set(d.PermissionSet!.Name!, arn);
      }
    }
    arnByName = m;
  }
  const arn = arnByName.get(name);
  if (!arn) throw new Error(`Permission set ${name} not found.`);
  const tags = await sso.send(new ListTagsForResourceCommand({ InstanceArn: instanceArn, ResourceArn: arn }));
  if (!tags.Tags?.some((t) => t.Key === MANAGED_TAG.key && t.Value === MANAGED_TAG.value)) {
    throw new Error(`Permission set ${name} is missing tag ${MANAGED_TAG.key}=${MANAGED_TAG.value}.`);
  }
  return arn;
}

export async function hasUserAssignment(instanceArn: string, accountId: string, psArn: string, userId: string) {
  for await (const page of paginateListAccountAssignments(
    { client: sso },
    { InstanceArn: instanceArn, AccountId: accountId, PermissionSetArn: psArn },
  )) {
    if (page.AccountAssignments?.some((a) => a.PrincipalType === "USER" && a.PrincipalId === userId)) return true;
  }
  return false;
}

export async function createAssignment(instanceArn: string, accountId: string, psArn: string, userId: string) {
  const res = await retry(() => sso.send(
    new CreateAccountAssignmentCommand({
      InstanceArn: instanceArn,
      TargetId: accountId,
      TargetType: "AWS_ACCOUNT",
      PermissionSetArn: psArn,
      PrincipalType: "USER",
      PrincipalId: userId,
    }),
  ));
  await waitFor(async () => {
    const s = await sso.send(
      new DescribeAccountAssignmentCreationStatusCommand({
        InstanceArn: instanceArn,
        AccountAssignmentCreationRequestId: res.AccountAssignmentCreationStatus!.RequestId,
      }),
    );
    return [s.AccountAssignmentCreationStatus!.Status!, s.AccountAssignmentCreationStatus!.FailureReason];
  });
}

export async function deleteAssignment(instanceArn: string, accountId: string, psArn: string, userId: string) {
  if (!(await hasUserAssignment(instanceArn, accountId, psArn, userId))) return;
  const res = await retry(() => sso.send(
    new DeleteAccountAssignmentCommand({
      InstanceArn: instanceArn,
      TargetId: accountId,
      TargetType: "AWS_ACCOUNT",
      PermissionSetArn: psArn,
      PrincipalType: "USER",
      PrincipalId: userId,
    }),
  ));
  await waitFor(async () => {
    const s = await sso.send(
      new DescribeAccountAssignmentDeletionStatusCommand({
        InstanceArn: instanceArn,
        AccountAssignmentDeletionRequestId: res.AccountAssignmentDeletionStatus!.RequestId,
      }),
    );
    return [s.AccountAssignmentDeletionStatus!.Status!, s.AccountAssignmentDeletionStatus!.FailureReason];
  });
}

/** Writes the revocation inline policy, or removes it when doc is null, then provisions it. */
export async function applyInlinePolicy(instanceArn: string, psArn: string, doc: string | null) {
  const current = await sso.send(
    new GetInlinePolicyForPermissionSetCommand({ InstanceArn: instanceArn, PermissionSetArn: psArn }),
  );
  if (!isOwnedPolicy(current.InlinePolicy)) {
    throw new Error(`Permission set ${psArn} has an inline policy this app did not write. Refusing to overwrite it.`);
  }
  if ((current.InlinePolicy || null) === doc) return;
  if (doc) {
    await retry(() =>
      sso.send(
        new PutInlinePolicyToPermissionSetCommand({ InstanceArn: instanceArn, PermissionSetArn: psArn, InlinePolicy: doc }),
      ),
    );
  } else if (current.InlinePolicy) {
    await retry(() =>
      sso.send(new DeleteInlinePolicyFromPermissionSetCommand({ InstanceArn: instanceArn, PermissionSetArn: psArn })),
    );
  }
  const res = await retry(() =>
    sso.send(
      new ProvisionPermissionSetCommand({
        InstanceArn: instanceArn,
        PermissionSetArn: psArn,
        TargetType: "ALL_PROVISIONED_ACCOUNTS",
      }),
    ),
  );
  await waitFor(async () => {
    const s = await sso.send(
      new DescribePermissionSetProvisioningStatusCommand({
        InstanceArn: instanceArn,
        ProvisionPermissionSetRequestId: res.PermissionSetProvisioningStatus!.RequestId,
      }),
    );
    return [s.PermissionSetProvisioningStatus!.Status!, s.PermissionSetProvisioningStatus!.FailureReason];
  });
}

async function waitFor(check: () => Promise<[string, string | undefined]>, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  for (let delay = 1000; Date.now() < deadline; delay = Math.min(delay * 2, 8000)) {
    const [status, reason] = await check();
    if (status === "SUCCEEDED") return;
    if (status === "FAILED") throw new Error(`Identity Center operation failed: ${reason ?? "no reason given"}`);
    await sleep(delay);
  }
  throw new Error("Timed out waiting for Identity Center operation.");
}

async function retry<T>(fn: () => Promise<T>, attempts = 6): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      const retryable = e instanceof ConflictException || e instanceof ThrottlingException;
      if (!retryable || i >= attempts - 1) throw e;
      await sleep(1000 * 2 ** i);
    }
  }
}
