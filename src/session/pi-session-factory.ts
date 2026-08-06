import { isAbsolute, join, relative, sep } from "node:path";
import {
  defaultPiSdkFacade,
  type PiSdkFacade,
  type PiSessionSettings,
} from "./pi-sdk-facade.ts";
import { PiSessionStream } from "./pi-session-stream.ts";

export type PiModelDescription = Readonly<{
  provider: string;
  id: string;
}>;

export type PiSessionFactoryConfig = Readonly<{
  model: PiModelDescription;
  systemPrompt: string;
  workspaceDirectory: string;
  agentDirectory: string;
  sessionDirectory: string;
  sessionFile: string;
}>;

export const SAFE_PI_SESSION_SETTINGS: PiSessionSettings = Object.freeze({
  compaction: Object.freeze({ enabled: true }),
  retry: Object.freeze({ enabled: true, maxRetries: 3 }),
});

export async function createPiSessionStream(
  config: PiSessionFactoryConfig,
  sdk: PiSdkFacade = defaultPiSdkFacade,
): Promise<PiSessionStream> {
  validateConfig(config);

  const modelRuntime = await sdk.createModelRuntime({
    authPath: join(config.agentDirectory, "auth.json"),
    modelsPath: join(config.agentDirectory, "models.json"),
    allowModelNetwork: false,
  });
  const model = modelRuntime.getModel(config.model.provider, config.model.id);
  if (!model) {
    throw new Error(`Pi model is not configured: ${config.model.provider}/${config.model.id}`);
  }

  const settingsManager = sdk.createSettingsManager(SAFE_PI_SESSION_SETTINGS);
  const resourceLoader = sdk.createResourceLoader(config.systemPrompt);
  const sessionManager = sdk.openSession({
    sessionFile: config.sessionFile,
    sessionDirectory: config.sessionDirectory,
    workspaceDirectory: config.workspaceDirectory,
  });
  const result = await sdk.createSession({
    cwd: config.workspaceDirectory,
    agentDir: config.agentDirectory,
    modelRuntime,
    model,
    noTools: "all",
    resourceLoader,
    sessionManager,
    settingsManager,
  });

  const initializationErrors = [
    ...result.extensionErrors,
    ...(result.modelFallbackMessage ? [result.modelFallbackMessage] : []),
  ];
  if (initializationErrors.length > 0) {
    result.session.dispose();
    throw new Error(`Pi session initialization failed: ${initializationErrors.join("; ")}`);
  }

  return new PiSessionStream(result.session);
}

function validateConfig(config: PiSessionFactoryConfig): void {
  requireText("model.provider", config.model.provider);
  requireText("model.id", config.model.id);
  requireText("systemPrompt", config.systemPrompt);
  requireAbsolutePath("workspaceDirectory", config.workspaceDirectory);
  requireAbsolutePath("agentDirectory", config.agentDirectory);
  requireAbsolutePath("sessionDirectory", config.sessionDirectory);
  requireAbsolutePath("sessionFile", config.sessionFile);
  const relativeSessionFile = relative(config.sessionDirectory, config.sessionFile);
  if (
    !relativeSessionFile ||
    relativeSessionFile === ".." ||
    relativeSessionFile.startsWith(`..${sep}`) ||
    isAbsolute(relativeSessionFile)
  ) {
    throw new Error("sessionFile must be inside sessionDirectory");
  }
}

function requireText(name: string, value: string): void {
  if (!value.trim()) throw new Error(`${name} must not be empty`);
}

function requireAbsolutePath(name: string, value: string): void {
  requireText(name, value);
  if (!isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
}
