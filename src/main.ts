import { chmod, mkdir } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { FileConversationHistoryStore } from "./conversation/file-history-store.ts";
import { OpenAIChatService } from "./openai/service.ts";
import { createPiSessionFactory } from "./session/pi-session.ts";

export type ServerConfig = Readonly<{
  hostname: string;
  port: number;
  serviceTokenFile: string;
  model: Readonly<{ provider: string; id: string }>;
  systemPromptFile: string;
  workspaceDirectory: string;
  sessionDirectory: string;
  agentDirectory: string;
}>;

export function configFromMiseEnvironment(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const listen = required(env, "usage_listen");
  const separator = listen.lastIndexOf(":");
  if (separator < 1) throw new Error("--listen must be HOST:PORT");
  const hostname = listen.slice(0, separator);
  const port = Number.parseInt(listen.slice(separator + 1), 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("--listen port must be between 1 and 65535");
  const modelValue = required(env, "usage_pi_model");
  const modelSeparator = modelValue.indexOf("/");
  if (modelSeparator < 1 || modelSeparator === modelValue.length - 1) throw new Error("--pi-model must be PROVIDER/MODEL");
  return {
    hostname,
    port,
    serviceTokenFile: absolute(required(env, "usage_service_token_file"), "--service-token-file"),
    model: { provider: modelValue.slice(0, modelSeparator), id: modelValue.slice(modelSeparator + 1) },
    systemPromptFile: absolute(required(env, "usage_system_prompt_file"), "--system-prompt-file"),
    workspaceDirectory: absolute(required(env, "usage_workspace"), "--workspace"),
    sessionDirectory: absolute(required(env, "usage_session_dir"), "--session-dir"),
    agentDirectory: absolute(required(env, "usage_agent_dir"), "--agent-dir"),
  };
}

export async function runServer(config: ServerConfig): Promise<void> {
  await mkdir(config.sessionDirectory, { recursive: true, mode: 0o700 });
  await chmod(config.sessionDirectory, 0o700);
  const [bearerToken, systemPrompt] = await Promise.all([
    Bun.file(config.serviceTokenFile).text(),
    Bun.file(config.systemPromptFile).text(),
  ]);
  if (!bearerToken.trim()) throw new Error("Service token file is empty");
  if (!systemPrompt.trim()) throw new Error("System prompt file is empty");
  const modelId = `${config.model.provider}/${config.model.id}`;
  const service = new OpenAIChatService({
    bearerToken: bearerToken.trim(),
    modelId,
    historyStore: new FileConversationHistoryStore(config.sessionDirectory),
    createAgent: createPiSessionFactory({
      model: config.model,
      systemPrompt,
      workspaceDirectory: config.workspaceDirectory,
      sessionDirectory: config.sessionDirectory,
      agentDirectory: config.agentDirectory,
    }),
  });
  const server = Bun.serve({
    hostname: config.hostname,
    port: config.port,
    fetch: (request) => service.fetch(request),
  });
  process.stdout.write(`Stein session service listening on ${server.url.origin}\n`);
  await new Promise<void>(() => {});
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
