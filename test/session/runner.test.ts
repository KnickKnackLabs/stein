import { describe, expect, test } from "bun:test";
import { sessionRunnerConfigFromMiseEnvironment } from "../../src/session/runner.ts";

const environment = {
  usage_pi_model: "test/deterministic",
  usage_system_prompt_file: "/private/tmp/system.md",
  usage_prompt_file: "/private/tmp/prompt.md",
  usage_workspace: "/private/tmp/workspace",
  usage_session_dir: "/private/tmp/sessions",
  usage_agent_dir: "/private/tmp/agent",
  usage_conversation_id: "fictional-conversation",
};

describe("session runner configuration", () => {
  test("parses every explicit operator input", () => {
    expect(sessionRunnerConfigFromMiseEnvironment(environment)).toEqual({
      conversationId: "fictional-conversation",
      model: { provider: "test", id: "deterministic" },
      systemPromptFile: "/private/tmp/system.md",
      promptFile: "/private/tmp/prompt.md",
      workspaceDirectory: "/private/tmp/workspace",
      sessionDirectory: "/private/tmp/sessions",
      agentDirectory: "/private/tmp/agent",
    });
  });

  test("fails closed when required configuration is absent or relative", () => {
    expect(() =>
      sessionRunnerConfigFromMiseEnvironment({ ...environment, usage_pi_model: "deterministic" }),
    ).toThrow("PROVIDER/MODEL");
    expect(() =>
      sessionRunnerConfigFromMiseEnvironment({ ...environment, usage_prompt_file: "prompt.md" }),
    ).toThrow("--prompt-file must be an absolute path");
    const { usage_conversation_id: _, ...missingConversation } = environment;
    expect(() => sessionRunnerConfigFromMiseEnvironment(missingConversation)).toThrow(
      "usage_conversation_id is required",
    );
  });
});
