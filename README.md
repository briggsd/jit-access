# jit-access

Just-in-time AWS account access through IAM Identity Center, requested and approved in Slack.

A user runs `/jit`, picks an account and permission set they are eligible for, and gives a reason.
Approvers click Approve in Slack. A Step Functions workflow creates a temporary account assignment,
waits until the end time, then removes it. Removal also adds a deny on credentials issued before the
revoke, so active sessions stop working instead of running until they expire.

## Setup

1. **Sign in to the tooling account.** Run `aws configure sso` and pick the account that is the
   Identity Center delegated administrator. Export `AWS_PROFILE` for the steps below.
2. **Let the tooling account read the org.** From the management account, attach an Organizations
   resource policy that allows the tooling account `organizations:ListAccounts`,
   `organizations:DescribeOrganization`, `organizations:ListAccountsForParent`,
   `organizations:ListOrganizationalUnitsForParent`, and `organizations:DescribeAccount`.
3. **Create the JIT permission sets.** Each one needs the tag `jit:managed=true`, a session duration
   equal to `sessionDurationMinutes` in the config, and no inline policy. The app owns the inline
   policy and refuses to touch a set without the tag. Do not give anyone standing assignments to them.
4. **Configure.** Copy `config/jit.config.example.ts` to `config/jit.config.ts` and fill it in.
5. **Deploy.**
   ```sh
   npm install
   npx cdk bootstrap
   npx cdk deploy
   ```
6. **Create the Slack app** from `slack-manifest.yaml`, using the `SlackRequestUrl` output. Install it,
   invite the bot to the approval channels, then store its secrets:
   ```sh
   aws secretsmanager put-secret-value --secret-id <SlackSecretArn> \
     --secret-string '{"botToken":"xoxb-...","signingSecret":"..."}'
   ```

## Rules the app enforces

- Requesters cannot approve their own requests.
- The management account is never a target. A delegated administrator cannot manage it.
- A user with a standing direct assignment to a target cannot request it, so expiry never removes standing access.
- One open request per user, account, and permission set.
- Slack users map to Identity Center users by email.

## Development

```sh
npm test          # unit tests
npm run typecheck
JIT_CONFIG=$PWD/config/jit.config.example.ts CDK_DEFAULT_ACCOUNT=123456789012 npx cdk synth
```
