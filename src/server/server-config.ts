import { isAbsolute, resolve } from "node:path";
import type { ModelDescription } from "../session/pi-session.ts";

export type ServerConfig = Readonly<{
  hostname: string;
  port: number;
  serviceTokenFile: string;
  model: ModelDescription;
  systemPromptFile: string;
  workspaceDirectory: string;
  sessionDirectory: string;
  agentDirectory: string;
}>;

export function serverConfigFromMiseEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): ServerConfig {
  const { hostname, port } = parseListen(required(env, "usage_listen"));
  return {
    hostname,
    port,
    serviceTokenFile: absolute(required(env, "usage_service_token_file"), "--service-token-file"),
    model: parseModel(required(env, "usage_pi_model")),
    systemPromptFile: absolute(required(env, "usage_system_prompt_file"), "--system-prompt-file"),
    workspaceDirectory: absolute(required(env, "usage_workspace"), "--workspace"),
    sessionDirectory: absolute(required(env, "usage_session_dir"), "--session-dir"),
    agentDirectory: absolute(required(env, "usage_agent_dir"), "--agent-dir"),
  };
}

function parseListen(value: string): { hostname: string; port: number } {
  const separator = value.lastIndexOf(":");
  const hostname = value.slice(0, separator).trim();
  const portValue = value.slice(separator + 1);
  if (separator < 1 || !hostname || !/^\d+$/.test(portValue)) {
    throw new Error("--listen must be HOST:PORT");
  }
  const port = Number(portValue);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("--listen port must be between 1 and 65535");
  }
  return { hostname, port };
}

function parseModel(value: string): ModelDescription {
  const separator = value.indexOf("/");
  if (separator < 1 || separator === value.length - 1) {
    throw new Error("--pi-model must be PROVIDER/MODEL");
  }
  return {
    provider: value.slice(0, separator),
    id: value.slice(separator + 1),
  };
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function absolute(value: string, flag: string): string {
  if (!isAbsolute(value)) throw new Error(`${flag} must be an absolute path`);
  return resolve(value);
}
