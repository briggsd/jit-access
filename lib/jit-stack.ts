import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as sfn from "aws-cdk-lib/aws-stepfunctions";
import * as tasks from "aws-cdk-lib/aws-stepfunctions-tasks";
import type { Construct } from "constructs";
import type { JitConfig } from "../src/domain/config.js";

export interface JitStackProps extends StackProps {
  jit: JitConfig;
}

const root = fileURLToPath(new URL("..", import.meta.url));

export class JitStack extends Stack {
  constructor(scope: Construct, id: string, props: JitStackProps) {
    super(scope, id, props);
    const { jit } = props;

    const requests = new dynamodb.TableV2(this, "Requests", {
      partitionKey: { name: "requestId", type: dynamodb.AttributeType.STRING },
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      deletionProtection: true,
      removalPolicy: RemovalPolicy.RETAIN,
      globalSecondaryIndexes: [
        {
          indexName: "byRequester",
          partitionKey: { name: "requesterUserId", type: dynamodb.AttributeType.STRING },
          sortKey: { name: "createdAt", type: dynamodb.AttributeType.STRING },
        },
      ],
    });
    const revocations = new dynamodb.TableV2(this, "Revocations", {
      partitionKey: { name: "permissionSetArn", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "entryId", type: dynamodb.AttributeType.STRING },
      timeToLiveAttribute: "expiresAt",
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const slackSecret = new secretsmanager.Secret(this, "SlackSecret", {
      description: 'JSON: {"botToken":"xoxb-...","signingSecret":"..."}',
    });

    // Bundle the config next to each handler so its size is not limited by env vars.
    const configDir = mkdtempSync(join(tmpdir(), "jit-config-"));
    const configFile = join(configDir, "jit-config.json");
    writeFileSync(configFile, JSON.stringify(jit));

    const fn = (name: string, entry: string, timeout: Duration, memorySize = 512) =>
      new NodejsFunction(this, name, {
        entry: join(root, entry),
        runtime: lambda.Runtime.NODEJS_24_X,
        architecture: lambda.Architecture.ARM_64,
        timeout,
        memorySize,
        logGroup: new logs.LogGroup(this, `${name}Logs`, { retention: logs.RetentionDays.ONE_YEAR }),
        environment: {
          REQUESTS_TABLE: requests.tableName,
          REVOCATIONS_TABLE: revocations.tableName,
          SLACK_SECRET_ARN: slackSecret.secretArn,
        },
        bundling: {
          commandHooks: {
            beforeBundling: () => [],
            beforeInstall: () => [],
            afterBundling: (_in: string, out: string) => [`cp "${configFile}" "${out}/jit-config.json"`],
          },
        },
      });

    const ingress = fn("Ingress", "src/handlers/ingress.ts", Duration.seconds(10));
    const worker = fn("Worker", "src/handlers/worker.ts", Duration.minutes(5));
    const lifecycle = fn("Lifecycle", "src/handlers/lifecycle.ts", Duration.minutes(10));

    // A failed submit must not be retried, or it would create duplicate requests.
    new lambda.EventInvokeConfig(this, "WorkerInvokeConfig", { function: worker, retryAttempts: 0 });

    const accessPolicy = new iam.PolicyStatement({
      actions: [
        "sso:CreateAccountAssignment",
        "sso:DeleteAccountAssignment",
        "sso:DescribeAccountAssignmentCreationStatus",
        "sso:DescribeAccountAssignmentDeletionStatus",
        "sso:ListAccountAssignments",
        "sso:ListPermissionSets",
        "sso:DescribePermissionSet",
        "sso:ListTagsForResource",
        "sso:GetInlinePolicyForPermissionSet",
        "sso:PutInlinePolicyToPermissionSet",
        "sso:DeleteInlinePolicyFromPermissionSet",
        "sso:ProvisionPermissionSet",
        "sso:DescribePermissionSetProvisioningStatus",
        "identitystore:GetUserId",
        "identitystore:DescribeUser",
        "identitystore:DescribeGroup",
        "identitystore:ListGroupMembershipsForMember",
        "organizations:ListAccounts",
        "organizations:DescribeOrganization",
        "organizations:ListAccountsForParent",
        "organizations:ListOrganizationalUnitsForParent",
        "organizations:DescribeAccount",
      ],
      resources: ["*"],
    });
    // Identity Center checks these on the caller when it provisions roles.
    const provisionPolicy = new iam.PolicyStatement({
      actions: [
        "iam:GetRole",
        "iam:CreateRole",
        "iam:DeleteRole",
        "iam:PutRolePolicy",
        "iam:DeleteRolePolicy",
        "iam:AttachRolePolicy",
        "iam:DetachRolePolicy",
        "iam:ListRolePolicies",
        "iam:ListAttachedRolePolicies",
        "iam:GetSAMLProvider",
        "iam:CreateSAMLProvider",
        "iam:UpdateSAMLProvider",
      ],
      resources: ["arn:aws:iam::*:role/aws-reserved/sso.amazonaws.com/*", "arn:aws:iam::*:saml-provider/AWSSSO_*"],
    });

    for (const f of [worker, lifecycle]) {
      f.addToRolePolicy(accessPolicy);
      f.addToRolePolicy(provisionPolicy);
      requests.grantReadWriteData(f);
      revocations.grantReadWriteData(f);
      slackSecret.grantRead(f);
    }
    slackSecret.grantRead(ingress);
    worker.grantInvoke(ingress);
    ingress.addEnvironment("WORKER_FUNCTION", worker.functionName);

    const invoke = (id: string, action: string, requestIdPath: string, extra: Record<string, unknown> = {}) =>
      new tasks.LambdaInvoke(this, id, {
        lambdaFunction: lifecycle,
        payload: sfn.TaskInput.fromObject({ action, requestId: sfn.JsonPath.stringAt(requestIdPath), ...extra }),
        payloadResponseOnly: true,
      });

    const failTask = invoke("Fail", "fail", "$.requestId", { error: sfn.JsonPath.objectAt("$.error") });
    failTask.addRetry({ maxAttempts: 5, interval: Duration.seconds(10), backoffRate: 2 });

    const grant = invoke("Grant", "grant", "$.requestId");
    grant.addRetry({ errors: ["States.ALL"], maxAttempts: 3, interval: Duration.seconds(5), backoffRate: 2 });
    grant.addCatch(failTask, { resultPath: "$.error" });

    const expire = invoke("Expire", "expire", "$.requestId");
    expire.addRetry({ errors: ["States.ALL"], maxAttempts: 8, interval: Duration.seconds(10), backoffRate: 2 });
    expire.addCatch(failTask, { resultPath: "$.error" });

    const wait = new sfn.Wait(this, "WaitUntilEnd", { time: sfn.WaitTime.timestampPath("$.endsAt") });

    const machine = new sfn.StateMachine(this, "AccessLifecycle", {
      definitionBody: sfn.DefinitionBody.fromChainable(grant.next(wait).next(expire)),
      tracingEnabled: true,
    });
    machine.grantStartExecution(worker);
    machine.grantExecution(worker, "states:StopExecution");
    worker.addEnvironment("STATE_MACHINE_ARN", machine.stateMachineArn);

    // A failed execution can mean access was not removed. Someone must look.
    new cloudwatch.Alarm(this, "LifecycleFailures", {
      metric: machine.metricFailed({ period: Duration.minutes(5) }),
      threshold: 1,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: "A JIT access workflow failed. Check that the assignment was removed.",
    });

    const url = ingress.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.NONE });
    new CfnOutput(this, "SlackRequestUrl", { value: url.url });
    new CfnOutput(this, "SlackSecretArn", { value: slackSecret.secretArn });
  }
}
