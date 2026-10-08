import {
  DescribeGroupCommand,
  DescribeUserCommand,
  GetUserIdCommand,
  paginateListGroupMembershipsForMember,
} from "@aws-sdk/client-identitystore";
import { identity } from "./clients.js";

export interface IdcUser {
  userId: string;
  userName: string;
  groups: Set<string>;
}

const groupNames = new Map<string, string>();

export async function userByEmail(identityStoreId: string, email: string): Promise<IdcUser> {
  const { UserId } = await identity.send(
    new GetUserIdCommand({
      IdentityStoreId: identityStoreId,
      AlternateIdentifier: { UniqueAttribute: { AttributePath: "emails.value", AttributeValue: email } },
    }),
  );
  const user = await identity.send(new DescribeUserCommand({ IdentityStoreId: identityStoreId, UserId }));
  return { userId: UserId!, userName: user.UserName!, groups: await groupsFor(identityStoreId, UserId!) };
}

async function groupsFor(identityStoreId: string, userId: string): Promise<Set<string>> {
  const out = new Set<string>();
  for await (const page of paginateListGroupMembershipsForMember(
    { client: identity },
    { IdentityStoreId: identityStoreId, MemberId: { UserId: userId } },
  )) {
    for (const m of page.GroupMemberships ?? []) {
      const id = m.GroupId!;
      let name = groupNames.get(id);
      if (!name) {
        const g = await identity.send(new DescribeGroupCommand({ IdentityStoreId: identityStoreId, GroupId: id }));
        name = g.DisplayName!;
        groupNames.set(id, name);
      }
      out.add(name);
    }
  }
  return out;
}
