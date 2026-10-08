export type Approval =
  | { required: false }
  | { required: true; approverGroups: string[]; channelId?: string };

export interface EligibilityRule {
  name: string;
  /** Identity Center group display names whose members may request. */
  groups: string[];
  /** Explicit account IDs. */
  accounts?: string[];
  /** OU IDs. Expanded recursively to every account below them. */
  ous?: string[];
  /** Permission set names. Each must carry the tag jit:managed=true. */
  permissionSets: string[];
  maxDurationMinutes: number;
  approval: Approval;
}

export interface JitConfig {
  identityCenter: {
    instanceArn: string;
    identityStoreId: string;
    region: string;
    /** Access portal URL shown in Slack messages, such as https://d-123.awsapps.com/start. */
    accessPortalUrl?: string;
  };
  slack: {
    /** Default channel for approval requests. */
    approvalChannelId: string;
  };
  /**
   * Session duration configured on every JIT permission set, in minutes.
   * Revocation deny statements are kept this long, plus a margin.
   */
  sessionDurationMinutes: number;
  eligibility: EligibilityRule[];
}
