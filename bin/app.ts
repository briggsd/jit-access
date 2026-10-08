import { existsSync } from "node:fs";
import { App } from "aws-cdk-lib";
import { JitStack } from "../lib/jit-stack.js";
import type { JitConfig } from "../src/domain/config.js";

const path = process.env.JIT_CONFIG ?? new URL("../config/jit.config.ts", import.meta.url).pathname;
if (!existsSync(path)) {
  throw new Error(`Config not found at ${path}. Copy config/jit.config.example.ts to config/jit.config.ts.`);
}
const { config } = (await import(path)) as { config: JitConfig };

const app = new App();
new JitStack(app, "JitAccess", {
  jit: config,
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: config.identityCenter.region },
});
