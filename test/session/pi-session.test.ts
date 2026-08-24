import { describe, expect, test } from "bun:test";
import { createReadToolDefinition } from "@earendil-works/pi-coding-agent";
import { createPiSessionFactory, type PiSessionFactoryConfig } from "../../src/session/pi-session.ts";

const config: PiSessionFactoryConfig = {
  model: { provider: "test", id: "deterministic" },
  systemPrompt: "Fictional system prompt",
  workspaceDirectory: "/private/tmp/stein-workspace",
  sessionDirectory: "/private/tmp/stein-sessions",
  agentDirectory: "/private/tmp/stein-agent",
};

describe("Pi session factory", () => {
  test("accepts default and read-only Pi storage without opening a session", () => {
    expect(createPiSessionFactory(config)).toBeFunction();
    expect(createPiSessionFactory({ ...config, piStorageMode: "read-only" })).toBeFunction();
  });

  test("accepts an optional per-session activity observer", () => {
    expect(createPiSessionFactory({
      ...config,
      activity: ({ workspaceDirectory }) => ({
        roots: [{ virtualPath: "conversation", directory: workspaceDirectory }],
        sink: () => {},
      }),
    })).toBeFunction();
    expect(() => createPiSessionFactory({
      ...config,
      activity: "enabled" as never,
    })).toThrow("activity must be a function");
  });

  test("accepts explicit built-in and custom tool composition", () => {
    expect(createPiSessionFactory({
      ...config,
      tools: ["read"],
      customTools: [createReadToolDefinition(config.workspaceDirectory)],
    })).toBeFunction();
  });

  test("rejects blank active and custom tool names before SDK use", () => {
    expect(() => createPiSessionFactory({ ...config, tools: [" "] }))
      .toThrow("tools[0]");
    const customTool = createReadToolDefinition(config.workspaceDirectory);
    customTool.name = "";
    expect(() => createPiSessionFactory({ ...config, customTools: [customTool] }))
      .toThrow("customTools[0].name");
  });

  test("rejects empty model and prompt configuration before SDK use", () => {
    expect(() => createPiSessionFactory({ ...config, model: { provider: "", id: "deterministic" } })).toThrow("model.provider");
    expect(() => createPiSessionFactory({ ...config, systemPrompt: " " })).toThrow("systemPrompt");
  });

  test("rejects relative runtime paths before SDK use", () => {
    expect(() => createPiSessionFactory({ ...config, sessionDirectory: "sessions" })).toThrow("sessionDirectory must be an absolute path");
  });

  test("rejects unsafe persistent conversation identifiers before SDK use", async () => {
    const createSession = createPiSessionFactory(config);
    await expect(createSession("../other-session")).rejects.toThrow("conversationId");
  });
});
