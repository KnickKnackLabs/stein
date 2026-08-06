import { describe, expect, test } from "bun:test";
import {
  CHAT_COMPLETION_LIMITS,
  chatCompletionChunk,
  InvalidChatCompletionError,
  parseChatCompletion,
} from "../../src/openai/chat-completion.ts";

describe("OpenAI chat completion contract", () => {
  test("normalizes visible messages and attached text", () => {
    expect(parseChatCompletion({
      model: "test/model",
      stream: true,
      messages: [
        { role: "assistant", content: "Earlier" },
        {
          role: "user",
          content: "Continue",
          attachments: [{ name: "fictional.txt", text: "Attached text" }],
        },
      ],
    }, "test/model")).toEqual([
      { role: "assistant", content: "Earlier", attachments: [] },
      {
        role: "user",
        content: "Continue",
        attachments: [{ name: "fictional.txt", text: "Attached text" }],
      },
    ]);
  });

  test("requires a streaming request for the configured model", () => {
    expect(() => parseChatCompletion({
      model: "other/model",
      stream: true,
      messages: [{ role: "user", content: "Hello" }],
    }, "test/model")).toThrow("model must be \"test/model\"");
    expect(() => parseChatCompletion({
      model: "test/model",
      stream: false,
      messages: [{ role: "user", content: "Hello" }],
    }, "test/model")).toThrow(InvalidChatCompletionError);
  });

  test("rejects a request that cannot begin a user turn", () => {
    expect(() => parseChatCompletion({
      model: "test/model",
      stream: true,
      messages: [{ role: "assistant", content: "No user turn" }],
    }, "test/model")).toThrow("Last message must be a user message");
  });

  test("rejects empty user turns before opening a stream", () => {
    expect(() => parseChatCompletion({
      model: "test/model",
      stream: true,
      messages: [{
        role: "user",
        content: "  ",
        attachments: [{ name: "empty.txt", text: "\n" }],
      }],
    }, "test/model")).toThrow("user turn must contain text or non-empty attached text");
  });

  test("enforces aggregate message, attachment, and UTF-8 text limits", () => {
    expect(() => parseChatCompletion({
      model: "test/model",
      stream: true,
      messages: Array.from(
        { length: CHAT_COMPLETION_LIMITS.messages + 1 },
        () => ({ role: "user", content: "text" }),
      ),
    }, "test/model")).toThrow(`at most ${CHAT_COMPLETION_LIMITS.messages} entries`);

    expect(() => parseChatCompletion({
      model: "test/model",
      stream: true,
      messages: [{
        role: "user",
        content: "text",
        attachments: Array.from(
          { length: CHAT_COMPLETION_LIMITS.attachments + 1 },
          (_, index) => ({ name: `${index}.txt`, text: "text" }),
        ),
      }],
    }, "test/model")).toThrow(`at most ${CHAT_COMPLETION_LIMITS.attachments} attachments`);

    expect(() => parseChatCompletion({
      model: "test/model",
      stream: true,
      messages: [{
        role: "user",
        content: "a".repeat(CHAT_COMPLETION_LIMITS.textBytes + 1),
      }],
    }, "test/model")).toThrow(`at most ${CHAT_COMPLETION_LIMITS.textBytes} bytes`);
  });

  test("encodes one OpenAI-compatible SSE chunk", () => {
    const chunk = chatCompletionChunk(
      "chatcmpl-test",
      42,
      "test/model",
      { content: "hello" },
      null,
    );
    expect(chunk.endsWith("\n\n")).toBe(true);
    expect(JSON.parse(chunk.slice("data: ".length))).toEqual({
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      created: 42,
      model: "test/model",
      choices: [{ index: 0, delta: { content: "hello" }, finish_reason: null }],
    });
  });
});
