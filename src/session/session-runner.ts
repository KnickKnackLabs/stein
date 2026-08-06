import { chmod, mkdir, readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { createPiSessionFactory, type ModelDescription } from "./pi-session.ts";

export type SessionRunnerConfig = Readonly<{
  conversationId: string;
  model: ModelDescription;
  systemPromptFile: string;
  promptFile: string;
  workspaceDirectory: string;
  sessionDirectory: string;
  agentDirectory: string;
}>;

export function sessionRunnerConfigFromMiseEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): SessionRunnerConfig {
  const modelValue = required(env, "usage_pi_model");
  const separator = modelValue.indexOf("/");
  if (separator < 1 || separator === modelValue.length - 1) {
    throw new Error("--pi-model must be PROVIDER/MODEL");
  }
  return {
    conversationId: required(env, "usage_conversation_id"),
    model: {
      provider: modelValue.slice(0, separator),
      id: modelValue.slice(separator + 1),
    },
    systemPromptFile: absolute(required(env, "usage_system_prompt_file"), "--system-prompt-file"),
    promptFile: absolute(required(env, "usage_prompt_file"), "--prompt-file"),
    workspaceDirectory: absolute(required(env, "usage_workspace"), "--workspace"),
    sessionDirectory: absolute(required(env, "usage_session_dir"), "--session-dir"),
    agentDirectory: absolute(required(env, "usage_agent_dir"), "--agent-dir"),
  };
}

export async function runSession(config: SessionRunnerConfig): Promise<void> {
  const [systemPrompt, prompt] = await Promise.all([
    readFile(config.systemPromptFile, "utf8"),
    readFile(config.promptFile, "utf8"),
  ]);
  if (!systemPrompt.trim()) throw new Error("System prompt file is empty");
  if (!prompt.trim()) throw new Error("Prompt file is empty");

  await mkdir(config.sessionDirectory, { recursive: true, mode: 0o700 });
  await chmod(config.sessionDirectory, 0o700);
  const createSession = createPiSessionFactory({
    model: config.model,
    systemPrompt,
    workspaceDirectory: config.workspaceDirectory,
    sessionDirectory: config.sessionDirectory,
    agentDirectory: config.agentDirectory,
  });
  const session = await createSession(config.conversationId);
  try {
    for await (const chunk of session.respond({
      conversationId: config.conversationId,
      userText: prompt,
      attachments: [],
    })) {
      process.stdout.write(chunk);
    }
  } finally {
    session.dispose();
  }
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
