import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  createPiSessionFactory,
  type PiSessionFactoryConfig,
} from "../../src/session/pi-session.ts";

function config(overrides: Partial<PiSessionFactoryConfig> = {}): PiSessionFactoryConfig {
  return {
    model: { provider: "test", id: "deterministic" },
    systemPrompt: "Fictional system prompt",
    workspaceDirectory: join("/tmp", "stein-workspace"),
    sessionDirectory: join("/tmp", "stein-sessions"),
    agentDirectory: join("/tmp", "stein-agent"),
    ...overrides,
  };
}

describe("Pi session factory", () => {
  test("accepts complete explicit configuration without opening a session", () => {
    expect(createPiSessionFactory(config())).toBeFunction();
  });

  test("rejects empty model and prompt configuration before SDK use", () => {
    expect(() => createPiSessionFactory(config({ model: { provider: "", id: "deterministic" } }))).toThrow("model.provider must not be empty");
    expect(() => createPiSessionFactory(config({ model: { provider: "test", id: "" } }))).toThrow("model.id must not be empty");
    expect(() => createPiSessionFactory(config({ systemPrompt: "  " }))).toThrow("systemPrompt must not be empty");
  });

  test("rejects relative runtime paths before SDK use", () => {
    expect(() => createPiSessionFactory(config({ workspaceDirectory: "workspace" }))).toThrow("workspaceDirectory must be an absolute path");
    expect(() => createPiSessionFactory(config({ sessionDirectory: "sessions" }))).toThrow("sessionDirectory must be an absolute path");
    expect(() => createPiSessionFactory(config({ agentDirectory: "agent" }))).toThrow("agentDirectory must be an absolute path");
  });
});
