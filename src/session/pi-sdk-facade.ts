import {
  createAgentSession,
  createExtensionRuntime,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type CreateAgentSessionOptions,
  type LoadExtensionsResult,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import type { PiSessionBackend } from "./pi-session-stream.ts";

export type PiModelRuntimeHandle = Readonly<{
  getModel(provider: string, modelId: string): unknown;
}>;

export type PiSessionSettings = Readonly<{
  compaction: Readonly<{ enabled: boolean }>;
  retry: Readonly<{ enabled: boolean; maxRetries: number }>;
}>;

export type PiSdkCreateSessionOptions = Readonly<{
  cwd: string;
  agentDir: string;
  modelRuntime: PiModelRuntimeHandle;
  model: unknown;
  noTools: "all";
  resourceLoader: object;
  sessionManager: object;
  settingsManager: object;
}>;

export type PiSdkSessionResult = Readonly<{
  session: PiSessionBackend;
  extensionErrors: readonly string[];
  modelFallbackMessage?: string;
}>;

export interface PiSdkFacade {
  createModelRuntime(options: Readonly<{
    authPath: string;
    modelsPath: string;
    allowModelNetwork: false;
  }>): Promise<PiModelRuntimeHandle>;
  createSettingsManager(settings: PiSessionSettings): object;
  createResourceLoader(systemPrompt: string): object;
  openSession(options: Readonly<{
    sessionFile: string;
    sessionDirectory: string;
    workspaceDirectory: string;
  }>): object;
  createSession(options: PiSdkCreateSessionOptions): Promise<PiSdkSessionResult>;
}

export function createSafeResourceLoader(systemPrompt: string): ResourceLoader {
  const extensions: LoadExtensionsResult = {
    extensions: [],
    errors: [],
    runtime: createExtensionRuntime(),
  };

  return {
    getExtensions: () => extensions,
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources(paths): void {
      const hasPaths =
        (paths.skillPaths?.length ?? 0) > 0 ||
        (paths.promptPaths?.length ?? 0) > 0 ||
        (paths.themePaths?.length ?? 0) > 0;
      if (hasPaths) throw new Error("Safe Pi resource loader does not accept discovered resources");
    },
    async reload(): Promise<void> {},
  };
}

const defaultPiSdkFacadeValue: PiSdkFacade = {
  createModelRuntime: (options) => ModelRuntime.create(options),
  createSettingsManager: (settings) => SettingsManager.inMemory(settings),
  createResourceLoader: (systemPrompt) => createSafeResourceLoader(systemPrompt),
  openSession: ({ sessionFile, sessionDirectory, workspaceDirectory }) =>
    SessionManager.open(sessionFile, sessionDirectory, workspaceDirectory),
  async createSession(options): Promise<PiSdkSessionResult> {
    const result = await createAgentSession({
      cwd: options.cwd,
      agentDir: options.agentDir,
      modelRuntime: options.modelRuntime as ModelRuntime,
      model: options.model as NonNullable<CreateAgentSessionOptions["model"]>,
      noTools: options.noTools,
      resourceLoader: options.resourceLoader as ResourceLoader,
      sessionManager: options.sessionManager as SessionManager,
      settingsManager: options.settingsManager as SettingsManager,
    });
    return {
      session: result.session as unknown as PiSessionBackend,
      extensionErrors: result.extensionsResult.errors.map(({ error }) => error),
      ...(result.modelFallbackMessage === undefined
        ? {}
        : { modelFallbackMessage: result.modelFallbackMessage }),
    };
  },
};

export const defaultPiSdkFacade: PiSdkFacade = Object.freeze(defaultPiSdkFacadeValue);
