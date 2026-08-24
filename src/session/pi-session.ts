import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { type SessionActivityOptions, subscribeToSessionActivity } from "./activity-events.ts";
import { SessionAgent } from "./agent.ts";
import { prepareConversationWorkspace } from "./conversation-workspace.ts";
import { createReadOnlyPiModelRuntime } from "./read-only-pi-credentials.ts";
import type { PiToolDefinition } from "./tool-definition.ts";

export type ModelDescription = Readonly<{ provider: string; id: string }>;
export type PiStorageMode = "default" | "read-only";

export type PiSessionRecovery = Readonly<{
  committedLeafId: string | null;
}>;

export type PiSessionActivityContext = Readonly<{
  conversationId: string;
  workspaceDirectory: string;
}>;

export type PiSessionActivityFactory = (
  context: PiSessionActivityContext,
) => SessionActivityOptions | undefined;

export type PiSessionFactoryConfig = Readonly<{
  model: ModelDescription;
  systemPrompt: string;
  /** Private root containing one mode-0700 workspace per conversation. */
  workspaceDirectory: string;
  sessionDirectory: string;
  agentDirectory: string;
  piStorageMode?: PiStorageMode;
  /** Exact active tool names, including any custom tools that should be enabled. */
  tools?: readonly string[];
  /** Custom tool definitions to register for this session factory. */
  customTools?: readonly PiToolDefinition[];
  /** Optional per-session privacy-safe tool activity observer. */
  activity?: PiSessionActivityFactory;
}>;

export function createPiSessionFactory(config: PiSessionFactoryConfig) {
  validateConfig(config);
  const tools = config.tools === undefined ? undefined : [...config.tools];
  const customTools = config.customTools === undefined ? undefined : [...config.customTools];
  const useNoToolsDefault = tools === undefined && customTools === undefined;
  return async (conversationId: string, recovery?: PiSessionRecovery): Promise<SessionAgent> => {
    validateConversationId(conversationId);
    const modelRuntime =
      config.piStorageMode === "read-only"
        ? await createReadOnlyPiModelRuntime(config.agentDirectory, config.model.provider)
        : await ModelRuntime.create({
            authPath: join(config.agentDirectory, "auth.json"),
            modelsPath: join(config.agentDirectory, "models.json"),
            allowModelNetwork: false,
          });
    const model = modelRuntime.getModel(config.model.provider, config.model.id);
    if (!model) {
      throw new Error(`Pi model is not configured: ${config.model.provider}/${config.model.id}`);
    }
    const conversationWorkspace = await prepareConversationWorkspace(
      config.workspaceDirectory,
      conversationId,
    );
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: true },
      retry: { enabled: true, maxRetries: 3 },
    });
    const resourceLoader = new DefaultResourceLoader({
      cwd: conversationWorkspace,
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
      conversationWorkspace,
      recovery,
    );
    const { session, extensionsResult, modelFallbackMessage } = await createAgentSession({
      cwd: conversationWorkspace,
      agentDir: config.agentDirectory,
      modelRuntime,
      model,
      ...(useNoToolsDefault
        ? { noTools: "all" as const }
        : {
            tools: [...(tools ?? [])],
            ...(customTools === undefined ? {} : { customTools: [...customTools] }),
          }),
      resourceLoader,
      sessionManager,
      settingsManager,
    });
    if (extensionsResult.errors.length > 0 || modelFallbackMessage) {
      session.dispose();
      const reason =
        modelFallbackMessage ?? extensionsResult.errors.map((entry) => entry.error).join("; ");
      throw new Error(`Pi session initialization failed: ${reason}`);
    }
    let disposeActivity: (() => void) | undefined;
    try {
      const activity = config.activity?.({
        conversationId,
        workspaceDirectory: conversationWorkspace,
      });
      if (activity) disposeActivity = subscribeToSessionActivity(session, activity);
    } catch (error) {
      session.dispose();
      throw error;
    }
    return new SessionAgent({
      conversationId,
      session,
      ...(disposeActivity ? { onDispose: disposeActivity } : {}),
    });
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

  const sessionManager = SessionManager.open(sessionFile, sessionDirectory, workspaceDirectory);
  if (recovery === undefined) return sessionManager;

  if (recovery.committedLeafId === null) {
    sessionManager.resetLeaf();
    return sessionManager;
  }
  try {
    sessionManager.branch(recovery.committedLeafId);
  } catch (error) {
    throw new Error(`Committed Pi session leaf is unavailable: ${recovery.committedLeafId}`, {
      cause: error,
    });
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
  if (
    config.piStorageMode !== undefined &&
    config.piStorageMode !== "default" &&
    config.piStorageMode !== "read-only"
  ) {
    throw new Error("piStorageMode must be default or read-only");
  }
  config.tools?.forEach((name, index) => {
    requireText(`tools[${index}]`, name);
  });
  config.customTools?.forEach((tool, index) => {
    requireText(`customTools[${index}].name`, tool.name);
  });
  if (config.activity !== undefined && typeof config.activity !== "function") {
    throw new Error("activity must be a function");
  }
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
