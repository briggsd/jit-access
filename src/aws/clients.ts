import { SSOAdminClient } from "@aws-sdk/client-sso-admin";
import { IdentitystoreClient } from "@aws-sdk/client-identitystore";
import { OrganizationsClient } from "@aws-sdk/client-organizations";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { SFNClient } from "@aws-sdk/client-sfn";
import { LambdaClient } from "@aws-sdk/client-lambda";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { config } from "../runtime/config.js";

const region = config().identityCenter.region;

export const sso = new SSOAdminClient({ region });
export const identity = new IdentitystoreClient({ region });
// Organizations is a global service with its endpoint in us-east-1.
export const org = new OrganizationsClient({ region: "us-east-1" });
export const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
export const sfn = new SFNClient({});
export const lambda = new LambdaClient({});
export const secrets = new SecretsManagerClient({});
