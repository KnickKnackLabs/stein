import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  createSafeResourceLoader,
  type PiSdkCreateSessionOptions,
  type PiSdkFacade,
  type PiSdkSessionResult,
  type PiSessionSettings,
} from "../../src/session/pi-sdk-facade.ts";
import {
  createPiSessionStream,
  SAFE_PI_SESSION_SETTINGS,
  type PiSessionFactoryConfig,
} from "../../src/session/pi-session-factory.ts";
import type { PiSessionBackend } from "../../src/session/pi-session-stream.ts";

class FakeSession implements PiSessionBackend {
  readonly prompts: string[] = [];
  readonly #listeners = new Set<(event: unknown) => void>();
  disposeCount = 0;

  subscribe(listener: (event: unknown) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async prompt(input: string): Promise<void> {
    this.prompts.push(input);
    for (const listener of this.#listeners) {
      listener({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "fictional reply" },
      });
    }
  }

  dispose(): void {
    this.disposeCount += 1;
  }
}

type FacadeCalls = {
  modelRuntime?: Parameters<PiSdkFacade["createModelRuntime"]>[0];
  settings?: PiSessionSettings;
  systemPrompt?: string;
  openSession?: Parameters<PiSdkFacade["openSession"]>[0];
  createSession?: PiSdkCreateSessionOptions;
};

function config(overrides: Partial<PiSessionFactoryConfig> = {}): PiSessionFactoryConfig {
  return {
    model: { provider: "test-provider", id: "test-model" },
    systemPrompt: "Fictional system prompt",
    workspaceDirectory: "/tmp/stein/workspace",
    agentDirectory: "/tmp/stein/agent",
    sessionDirectory: "/tmp/stein/sessions",
    sessionFile: "/tmp/stein/sessions/fictional.jsonl",
    ...overrides,
  };
}

function fakeFacade(options: Readonly<{
  model?: object | null;
  result?: PiSdkSessionResult;
}> = {}): { sdk: PiSdkFacade; calls: FacadeCalls; session: FakeSession } {
  const calls: FacadeCalls = {};
  const session = new FakeSession();
  const model = options.model === null ? undefined : (options.model ?? { id: "configured-model" });
  const result = options.result ?? { session, extensionErrors: [] };
  const sdk: PiSdkFacade = {
    async createModelRuntime(runtimeOptions) {
      calls.modelRuntime = runtimeOptions;
      return { getModel: () => model };
    },
    createSettingsManager(settings) {
      calls.settings = settings;
      return { kind: "settings" };
    },
    createResourceLoader(systemPrompt) {
      calls.systemPrompt = systemPrompt;
      return { kind: "resources" };
    },
    openSession(sessionOptions) {
      calls.openSession = sessionOptions;
      return { kind: "session-manager" };
    },
    async createSession(sessionOptions) {
      calls.createSession = sessionOptions;
      return result;
    },
  };
  return { sdk, calls, session };
}

async function collect(chunks: AsyncIterable<string>): Promise<string[]> {
  const output: string[] = [];
  for await (const chunk of chunks) output.push(chunk);
  return output;
}

describe("createPiSessionStream", () => {
  test("constructs one explicit safe-default Pi session without prompting", async () => {
    const { sdk, calls, session } = fakeFacade();
    const stream = await createPiSessionStream(config(), sdk);

    expect(calls.modelRuntime).toEqual({
      authPath: join("/tmp/stein/agent", "auth.json"),
      modelsPath: join("/tmp/stein/agent", "models.json"),
      allowModelNetwork: false,
    });
    expect(calls.settings).toEqual(SAFE_PI_SESSION_SETTINGS);
    expect(calls.systemPrompt).toBe("Fictional system prompt");
    expect(calls.openSession).toEqual({
      sessionFile: "/tmp/stein/sessions/fictional.jsonl",
      sessionDirectory: "/tmp/stein/sessions",
      workspaceDirectory: "/tmp/stein/workspace",
    });
    expect(calls.createSession).toEqual({
      cwd: "/tmp/stein/workspace",
      agentDir: "/tmp/stein/agent",
      modelRuntime: expect.any(Object),
      model: { id: "configured-model" },
      noTools: "all",
      resourceLoader: { kind: "resources" },
      sessionManager: { kind: "session-manager" },
      settingsManager: { kind: "settings" },
    });
    expect(session.prompts).toEqual([]);
    expect(await collect(stream.run("Fictional user prompt"))).toEqual(["fictional reply"]);
  });

  test("fails before session construction when the exact model is absent", async () => {
    const { sdk, calls } = fakeFacade({ model: null });

    await expect(createPiSessionStream(config(), sdk)).rejects.toThrow(
      "Pi model is not configured: test-provider/test-model",
    );
    expect(calls.createSession).toBeUndefined();
  });

  test("disposes sessions with extension initialization errors", async () => {
    const session = new FakeSession();
    const { sdk } = fakeFacade({
      result: { session, extensionErrors: ["fictional extension error"] },
    });

    await expect(createPiSessionStream(config(), sdk)).rejects.toThrow(
      "Pi session initialization failed: fictional extension error",
    );
    expect(session.disposeCount).toBe(1);
  });

  test("disposes sessions instead of accepting model fallback", async () => {
    const session = new FakeSession();
    const { sdk } = fakeFacade({
      result: {
        session,
        extensionErrors: [],
        modelFallbackMessage: "fictional fallback",
      },
    });

    await expect(createPiSessionStream(config(), sdk)).rejects.toThrow(
      "Pi session initialization failed: fictional fallback",
    );
    expect(session.disposeCount).toBe(1);
  });

  test("validates explicit text and path configuration before SDK use", async () => {
    const cases: Array<[Partial<PiSessionFactoryConfig>, string]> = [
      [{ model: { provider: " ", id: "model" } }, "model.provider must not be empty"],
      [{ model: { provider: "provider", id: " " } }, "model.id must not be empty"],
      [{ systemPrompt: " " }, "systemPrompt must not be empty"],
      [{ workspaceDirectory: "relative" }, "workspaceDirectory must be an absolute path"],
      [{ agentDirectory: "relative" }, "agentDirectory must be an absolute path"],
      [{ sessionDirectory: "relative" }, "sessionDirectory must be an absolute path"],
      [{ sessionFile: "relative" }, "sessionFile must be an absolute path"],
      [
        { sessionFile: "/tmp/stein/outside.jsonl" },
        "sessionFile must be inside sessionDirectory",
      ],
      [
        { sessionFile: "/tmp/stein/sessions" },
        "sessionFile must be inside sessionDirectory",
      ],
    ];

    for (const [overrides, message] of cases) {
      const { sdk, calls } = fakeFacade();
      await expect(createPiSessionStream(config(overrides), sdk)).rejects.toThrow(message);
      expect(calls.modelRuntime).toBeUndefined();
    }
  });
});

describe("createSafeResourceLoader", () => {
  test("exposes only the explicit system prompt", async () => {
    const loader = createSafeResourceLoader("Explicit prompt");

    expect(loader.getExtensions().extensions).toEqual([]);
    expect(loader.getExtensions().errors).toEqual([]);
    expect(loader.getSkills()).toEqual({ skills: [], diagnostics: [] });
    expect(loader.getPrompts()).toEqual({ prompts: [], diagnostics: [] });
    expect(loader.getThemes()).toEqual({ themes: [], diagnostics: [] });
    expect(loader.getAgentsFiles()).toEqual({ agentsFiles: [] });
    expect(loader.getSystemPrompt()).toBe("Explicit prompt");
    expect(loader.getSystemPromptSource()).toBeUndefined();
    expect(loader.getAppendSystemPrompt()).toEqual([]);
    expect(loader.getAppendSystemPromptSources()).toEqual([]);
    await loader.reload();
    expect(() =>
      loader.extendResources({
        skillPaths: [{ path: "/tmp/ambient-skill", metadata: {} as never }],
      }),
    ).toThrow("does not accept discovered resources");
  });
});
