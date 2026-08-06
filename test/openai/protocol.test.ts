import { describe, expect, test } from "bun:test";
import {
  InvalidChatRequestError,
  parseChatCompletionRequest,
  OPENAI_CHAT_LIMITS,
  sseChunk,
} from "../../src/openai/protocol.ts";

describe("OpenAI protocol", () => {
  test("normalizes visible messages and attached text", () => {
    expect(parseChatCompletionRequest({
      model: "test/model",
      stream: true,
      messages: [
        { role: "assistant", content: "Earlier" },
        { role: "user", content: "Continue", attachments: [{ name: "fictional.txt", text: "Attached text" }] },
      ],
    }, "test/model")).toEqual([
      { role: "assistant", content: "Earlier", attachments: [] },
      { role: "user", content: "Continue", attachments: [{ name: "fictional.txt", text: "Attached text" }] },
    ]);
  });

  test("rejects a request that cannot begin a user turn", () => {
    expect(() => parseChatCompletionRequest({
      model: "test/model",
      stream: true,
      messages: [{ role: "assistant", content: "No user turn" }],
    }, "test/model")).toThrow(InvalidChatRequestError);
  });

  test("rejects empty user turns before opening a stream", () => {
    expect(() => parseChatCompletionRequest({
      model: "test/model",
      stream: true,
      messages: [{ role: "user", content: "  ", attachments: [{ name: "empty.txt", text: "\n" }] }],
    }, "test/model")).toThrow("user turn must contain text or non-empty attached text");
  });

  test("enforces explicit message and attachment limits", () => {
    expect(() => parseChatCompletionRequest({
      model: "test/model",
      stream: true,
      messages: Array.from(
        { length: OPENAI_CHAT_LIMITS.messages + 1 },
        () => ({ role: "user", content: "text" }),
      ),
    }, "test/model")).toThrow(`at most ${OPENAI_CHAT_LIMITS.messages} entries`);

    expect(() => parseChatCompletionRequest({
      model: "test/model",
      stream: true,
      messages: [{
        role: "user",
        content: "text",
        attachments: Array.from(
          { length: OPENAI_CHAT_LIMITS.attachments + 1 },
          (_, index) => ({ name: `${index}.txt`, text: "text" }),
        ),
      }],
    }, "test/model")).toThrow(`at most ${OPENAI_CHAT_LIMITS.attachments} attachments`);
  });

  test("enforces the aggregate UTF-8 text limit across content and attachment names", () => {
    expect(() => parseChatCompletionRequest({
      model: "test/model",
      stream: true,
      messages: [{ role: "user", content: "a".repeat(OPENAI_CHAT_LIMITS.textBytes + 1) }],
    }, "test/model")).toThrow(`at most ${OPENAI_CHAT_LIMITS.textBytes} bytes`);

    expect(() => parseChatCompletionRequest({
      model: "test/model",
      stream: true,
      messages: [{
        role: "user",
        content: "",
        attachments: [{ name: "a".repeat(OPENAI_CHAT_LIMITS.textBytes), text: "x" }],
      }],
    }, "test/model")).toThrow(`at most ${OPENAI_CHAT_LIMITS.textBytes} bytes`);
  });

  test("encodes one OpenAI-compatible SSE chunk", () => {
    const chunk = sseChunk("chatcmpl-test", 42, "test/model", { content: "hello" }, null);
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
