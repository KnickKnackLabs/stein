import { describe, expect, test } from "bun:test";
import { createPiSessionFactory, type PiSessionFactoryConfig } from "../../src/session/pi-session.ts";

const config: PiSessionFactoryConfig = {
  model: { provider: "test", id: "deterministic" },
  systemPrompt: "Fictional system prompt",
  workspaceDirectory: "/private/tmp/stein-workspace",
  sessionDirectory: "/private/tmp/stein-sessions",
  agentDirectory: "/private/tmp/stein-agent",
};

describe("Pi session factory", () => {
  test("accepts complete explicit configuration without opening a session", () => {
    expect(createPiSessionFactory(config)).toBeFunction();
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
