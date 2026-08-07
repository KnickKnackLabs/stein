import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { SessionAgent } from "./session-agent.ts";

export type ModelDescription = Readonly<{ provider: string; id: string }>;

export type PiSessionRecovery = Readonly<{
  committedLeafId: string | null;
}>;

export type PiSessionFactoryConfig = Readonly<{
  model: ModelDescription;
  systemPrompt: string;
  workspaceDirectory: string;
  sessionDirectory: string;
  agentDirectory: string;
}>;

export function createPiSessionFactory(config: PiSessionFactoryConfig) {
  validateConfig(config);
  return async (
    conversationId: string,
    recovery?: PiSessionRecovery,
  ): Promise<SessionAgent> => {
    validateConversationId(conversationId);
    const modelRuntime = await ModelRuntime.create({
      authPath: join(config.agentDirectory, "auth.json"),
      modelsPath: join(config.agentDirectory, "models.json"),
      allowModelNetwork: false,
    });
    const model = modelRuntime.getModel(config.model.provider, config.model.id);
    if (!model) {
      throw new Error(`Pi model is not configured: ${config.model.provider}/${config.model.id}`);
    }
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: true },
      retry: { enabled: true, maxRetries: 3 },
    });
    const resourceLoader = new DefaultResourceLoader({
      cwd: config.workspaceDirectory,
      agentDir: config.agentDirectory,
      settingsManager,
      systemPrompt: config.systemPrompt,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await resourceLoader.reload();
    const sessionFile = join(config.sessionDirectory, `${conversationId}.jsonl`);
    const sessionManager = openSessionManagerForRecovery(
      sessionFile,
      config.sessionDirectory,
      config.workspaceDirectory,
      recovery,
    );
    const { session, extensionsResult, modelFallbackMessage } = await createAgentSession({
      cwd: config.workspaceDirectory,
      agentDir: config.agentDirectory,
      modelRuntime,
      model,
      noTools: "all",
      resourceLoader,
      sessionManager,
      settingsManager,
    });
    if (extensionsResult.errors.length > 0 || modelFallbackMessage) {
      session.dispose();
      const reason = modelFallbackMessage ?? extensionsResult.errors.map((entry) => entry.error).join("; ");
      throw new Error(`Pi session initialization failed: ${reason}`);
    }
    return new SessionAgent({ conversationId, session });
  };
}

export function openSessionManagerForRecovery(
  sessionFile: string,
  sessionDirectory: string,
  workspaceDirectory: string,
  recovery?: PiSessionRecovery,
): SessionManager {
  const sessionExists = existsSync(sessionFile);
  if (recovery !== undefined && recovery.committedLeafId !== null && !sessionExists) {
    throw new Error("Committed visible history has no Pi session file");
  }

  const sessionManager = SessionManager.open(
    sessionFile,
    sessionDirectory,
    workspaceDirectory,
  );
  if (recovery === undefined) return sessionManager;

  if (recovery.committedLeafId === null) {
    sessionManager.resetLeaf();
    return sessionManager;
  }
  try {
    sessionManager.branch(recovery.committedLeafId);
  } catch (error) {
    throw new Error(
      `Committed Pi session leaf is unavailable: ${recovery.committedLeafId}`,
      { cause: error },
    );
  }
  return sessionManager;
}

function validateConfig(config: PiSessionFactoryConfig): void {
  requireText("model.provider", config.model.provider);
  requireText("model.id", config.model.id);
  requireText("systemPrompt", config.systemPrompt);
  requireAbsolutePath("workspaceDirectory", config.workspaceDirectory);
  requireAbsolutePath("sessionDirectory", config.sessionDirectory);
  requireAbsolutePath("agentDirectory", config.agentDirectory);
}

function validateConversationId(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new Error("conversationId must contain 1-128 safe filename characters");
  }
}

function requireText(name: string, value: string): void {
  if (!value.trim()) throw new Error(`${name} must not be empty`);
}

function requireAbsolutePath(name: string, value: string): void {
  requireText(name, value);
  if (!isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
}
