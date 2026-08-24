import { describe, expect, test } from "bun:test";
import {
  CHAT_COMPLETION_LIMITS,
  parseChatCompletion,
} from "../../src/openai/chat-completion.ts";
import { kklOpenWebUiAttachmentNormalizer } from "../../src/openwebui/attachments.ts";

const MODEL = "test/model";

function parse(content: string, attachments?: readonly unknown[]) {
  return parseChatCompletion({
    model: MODEL,
    stream: true,
    messages: [{
      role: "user",
      content,
      ...(attachments ? { attachments } : {}),
    }],
  }, MODEL, kklOpenWebUiAttachmentNormalizer);
}

describe("KKL Open WebUI attachments", () => {
  test("remains opt-in at the generic chat boundary", () => {
    const content =
      "<attached_files><attached_file name=\"fictional.txt\">text" +
      "</attached_file></attached_files>";
    expect(parseChatCompletion({
      model: MODEL,
      stream: true,
      messages: [{ role: "user", content }],
    }, MODEL)).toEqual([{
      role: "user",
      content,
      attachments: [],
    }]);
  });

  test("de-tags embedded files and preserves structured attachments", () => {
    expect(parse(
      "Draft the document\n\n<attached_files>\n" +
        "<attached_file name=\"fictional-current.txt\">\n" +
        "FICTIONAL CONTENT.\n" +
        "</attached_file>\n</attached_files>",
      [{ name: "already-structured.txt", text: "Structured content." }],
    )).toEqual([{
      role: "user",
      content: "Draft the document",
      attachments: [
        { name: "fictional-current.txt", text: "\nFICTIONAL CONTENT.\n" },
        { name: "already-structured.txt", text: "Structured content." },
      ],
    }]);
  });

  test("unescapes HTML entities in embedded attachment names", () => {
    expect(parse(
      "<attached_files>\n" +
        "<attached_file name=\"prior &amp; current.txt\">\ntext\n</attached_file>\n" +
        "</attached_files>",
    )).toEqual([{
      role: "user",
      content: "",
      attachments: [{ name: "prior & current.txt", text: "\ntext\n" }],
    }]);
  });

  test("accepts a turn containing only embedded attachment text", () => {
    expect(parse(
      "<attached_files><attached_file name=\"fictional.txt\">hello" +
        "</attached_file></attached_files>",
    )).toEqual([{
      role: "user",
      content: "",
      attachments: [{ name: "fictional.txt", text: "hello" }],
    }]);
  });

  test("rejects invalid embedded names and enforces the shared attachment limit", () => {
    expect(() => parse("<attached_file name=\"\">text</attached_file>"))
      .toThrow("embedded attachment must contain a name");

    const content = Array.from(
      { length: CHAT_COMPLETION_LIMITS.attachments + 1 },
      (_, index) => `<attached_file name=\"${index}.txt\">text</attached_file>`,
    ).join("");
    expect(() => parse(content)).toThrow(
      `at most ${CHAT_COMPLETION_LIMITS.attachments} attachments`,
    );
  });
});
