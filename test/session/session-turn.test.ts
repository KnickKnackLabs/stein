import { describe, expect, test } from "bun:test";
import { type SessionTurn, serializeSessionTurn } from "../../src/session/session-turn.ts";

const conversationId = "fictional-conversation";
function turn(overrides: Partial<SessionTurn> = {}): SessionTurn {
  return {
    conversationId,
    userText: "A fictional user described a difficult transition.",
    attachments: [],
    ...overrides,
  };
}

describe("session turn", () => {
  test("serializes only model-relevant text and attachments", () => {
    const attachments = [{ name: "fictional-note.txt", text: "Already attached context." }];
    expect(JSON.parse(serializeSessionTurn(conversationId, turn({ attachments })))).toEqual({
      userText: "A fictional user described a difficult transition.",
      attachments,
    });
  });

  test("keeps conversation identity local", () => {
    expect(() => serializeSessionTurn(conversationId, turn({ conversationId: "other" }))).toThrow(
      "Conversation mismatch",
    );
  });

  test("accepts attachment-only turns", () => {
    const attachments = [
      { name: "fictional-note.txt", text: "Attached context without a message." },
    ];
    expect(
      JSON.parse(serializeSessionTurn(conversationId, turn({ userText: "  ", attachments }))),
    ).toEqual({
      userText: "  ",
      attachments,
    });
  });

  test("rejects empty turns and unnamed attachments", () => {
    expect(() =>
      serializeSessionTurn(conversationId, turn({ userText: "", attachments: [] })),
    ).toThrow("Turn must contain user text");
    expect(() =>
      serializeSessionTurn(conversationId, turn({ attachments: [{ name: " ", text: "context" }] })),
    ).toThrow("attachments[0].name");
  });
});
