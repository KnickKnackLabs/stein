import { describe, expect, test } from "bun:test";
import { configFromMiseEnvironment } from "../src/main.ts";

const valid = {
  usage_listen: "127.0.0.1:8787",
  usage_service_token_file: "/private/token",
  usage_pi_model: "test/deterministic",
  usage_system_prompt_file: "/private/prompt",
  usage_workspace: "/private/workspace",
  usage_session_dir: "/private/sessions",
  usage_agent_dir: "/private/agent",
};

describe("serve configuration", () => {
  test("parses every explicit operator input", () => {
    expect(configFromMiseEnvironment(valid)).toEqual({
      hostname: "127.0.0.1",
      port: 8787,
      serviceTokenFile: "/private/token",
      model: { provider: "test", id: "deterministic" },
      systemPromptFile: "/private/prompt",
      workspaceDirectory: "/private/workspace",
      sessionDirectory: "/private/sessions",
      agentDirectory: "/private/agent",
    });
  });

  test("fails closed when required config is absent or relative", () => {
    expect(() => configFromMiseEnvironment({ ...valid, usage_pi_model: undefined })).toThrow("usage_pi_model is required");
    expect(() => configFromMiseEnvironment({ ...valid, usage_workspace: "relative" })).toThrow("--workspace must be an absolute path");
  });
});
