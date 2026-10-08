import type { JitConfig } from "../src/domain/config.js";

export const config: JitConfig = {
  identityCenter: {
    instanceArn: "arn:aws:sso:::instance/ssoins-0000000000000000",
    identityStoreId: "d-0000000000",
    region: "us-east-1",
    accessPortalUrl: "https://d-0000000000.awsapps.com/start",
  },
  slack: { approvalChannelId: "C00000000" },
  // Set every JIT permission set's session duration to this value.
  sessionDurationMinutes: 60,
  eligibility: [
    {
      name: "engineers-dev-readonly",
      groups: ["Engineers"],
      ous: ["ou-xxxx-dev00000"],
      permissionSets: ["JitReadOnly"],
      maxDurationMinutes: 240,
      approval: { required: false },
    },
    {
      name: "engineers-prod-admin",
      groups: ["Engineers"],
      ous: ["ou-xxxx-prod0000"],
      permissionSets: ["JitAdmin"],
      maxDurationMinutes: 120,
      approval: { required: true, approverGroups: ["Platform-Leads"] },
    },
  ],
};
