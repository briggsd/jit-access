import { readFileSync } from "node:fs";
import type { JitConfig } from "../domain/config.js";

let cached: JitConfig | undefined;

/** The CDK stack bundles the config next to each handler as jit-config.json. */
export function config(): JitConfig {
  cached ??= JSON.parse(readFileSync(process.env.JIT_CONFIG_PATH ?? "/var/task/jit-config.json", "utf8"));
  return cached!;
}

export function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name}`);
  return v;
}
