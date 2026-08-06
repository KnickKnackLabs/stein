export type SessionAttachment = Readonly<{ name: string; text: string }>;

export type SessionTurn = Readonly<{
  conversationId: string;
  userText: string;
  attachments: readonly SessionAttachment[];
}>;

type SerializedTurn = Readonly<{
  userText: string;
  attachments: readonly SessionAttachment[];
}>;

export function serializeSessionTurn(
  expectedConversationId: string,
  turn: SessionTurn,
): string {
  if (turn.conversationId !== expectedConversationId) {
    throw new Error(
      `Conversation mismatch: expected ${JSON.stringify(expectedConversationId)}, received ${JSON.stringify(turn.conversationId)}`,
    );
  }
  const attachments = turn.attachments.map((attachment, index) => {
    requireText(`attachments[${index}].name`, attachment.name);
    return { name: attachment.name, text: attachment.text };
  });
  if (!turn.userText.trim() && !attachments.some((attachment) => attachment.text.trim())) {
    throw new Error("Turn must contain user text or non-empty attached text");
  }
  const serialized: SerializedTurn = {
    userText: turn.userText,
    attachments,
  };
  return JSON.stringify(serialized, null, 2);
}

function requireText(name: string, value: string): void {
  if (value.trim().length === 0) throw new Error(`${name} must not be empty`);
}
