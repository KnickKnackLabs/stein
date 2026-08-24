import type { ConversationMessage } from "../conversation/conversation.ts";
import type { AttachmentNormalizer } from "./attachment-normalizer.ts";

export class InvalidChatCompletionError extends Error {
  override readonly name = "InvalidChatCompletionError";
}

export const CHAT_COMPLETION_LIMITS = Object.freeze({
  messages: 200,
  attachments: 20,
  textBytes: 2 * 1024 * 1024,
});

export function parseChatCompletion(
  value: unknown,
  modelId: string,
  normalizeAttachments?: AttachmentNormalizer,
): ConversationMessage[] {
  if (!isRecord(value)) {
    throw new InvalidChatCompletionError("Request body must be an object");
  }
  if (value.stream !== true) {
    throw new InvalidChatCompletionError("Only streaming chat completions are supported");
  }
  if (value.model !== modelId) {
    throw new InvalidChatCompletionError(`model must be ${JSON.stringify(modelId)}`);
  }
  if (!Array.isArray(value.messages) || value.messages.length === 0) {
    throw new InvalidChatCompletionError("messages must be a non-empty array");
  }
  if (value.messages.length > CHAT_COMPLETION_LIMITS.messages) {
    throw new InvalidChatCompletionError(
      `messages must contain at most ${CHAT_COMPLETION_LIMITS.messages} entries`,
    );
  }

  const budget: RequestBudget = { attachmentCount: 0, textBytes: 0 };
  const messages = value.messages.map((message, index) =>
    parseMessage(message, index, budget, normalizeAttachments),
  );
  if (messages.at(-1)?.role !== "user") {
    throw new InvalidChatCompletionError("Last message must be a user message");
  }
  return messages;
}

type RequestBudget = {
  attachmentCount: number;
  textBytes: number;
};

function parseMessage(
  value: unknown,
  index: number,
  budget: RequestBudget,
  normalizeAttachments: AttachmentNormalizer | undefined,
): ConversationMessage {
  if (
    !isRecord(value) ||
    (value.role !== "user" && value.role !== "assistant") ||
    typeof value.content !== "string"
  ) {
    throw new InvalidChatCompletionError(
      `messages[${index}] must contain a user or assistant role and string content`,
    );
  }

  const structured = parseAttachments(value.attachments, value.role, index);
  if (value.role === "assistant") {
    addText(value.content, budget);
    return { role: "assistant", content: value.content, attachments: [] };
  }

  const normalized = normalizeAttachments?.({
    messageIndex: index,
    content: value.content,
    attachments: structured,
  }) ?? { content: value.content, attachments: structured };
  const { content, attachments } = validateNormalizedMessage(normalized, index);
  accountMessage(content, attachments, budget);
  if (!content.trim() && !attachments.some((attachment) => attachment.text.trim())) {
    throw new InvalidChatCompletionError(
      `messages[${index}] user turn must contain text or non-empty attached text`,
    );
  }
  return { role: "user", content, attachments };
}

function validateNormalizedMessage(
  value: unknown,
  messageIndex: number,
): Pick<ConversationMessage, "content" | "attachments"> {
  if (!isRecord(value) || typeof value.content !== "string" || !Array.isArray(value.attachments)) {
    throw new InvalidChatCompletionError(
      `messages[${messageIndex}] attachment normalizer must return content and attachments`,
    );
  }
  return {
    content: value.content,
    attachments: parseAttachments(value.attachments, "user", messageIndex),
  };
}

function parseAttachments(
  value: unknown,
  role: ConversationMessage["role"],
  messageIndex: number,
): ConversationMessage["attachments"] {
  if (value === undefined) return [];
  if (role !== "user" || !Array.isArray(value)) {
    throw new InvalidChatCompletionError(
      `messages[${messageIndex}].attachments must be an array on a user message`,
    );
  }

  return value.map((attachment, attachmentIndex) => {
    if (
      !isRecord(attachment) ||
      typeof attachment.name !== "string" ||
      !attachment.name.trim() ||
      typeof attachment.text !== "string"
    ) {
      throw new InvalidChatCompletionError(
        `messages[${messageIndex}].attachments[${attachmentIndex}] must contain name and text`,
      );
    }
    return { name: attachment.name, text: attachment.text };
  });
}

function accountMessage(
  content: string,
  attachments: ConversationMessage["attachments"],
  budget: RequestBudget,
): void {
  budget.attachmentCount += attachments.length;
  if (budget.attachmentCount > CHAT_COMPLETION_LIMITS.attachments) {
    throw new InvalidChatCompletionError(
      `messages must contain at most ${CHAT_COMPLETION_LIMITS.attachments} attachments`,
    );
  }
  addText(content, budget);
  for (const attachment of attachments) {
    addText(attachment.name, budget);
    addText(attachment.text, budget);
  }
}

const textEncoder = new TextEncoder();

function addText(text: string, budget: RequestBudget): void {
  budget.textBytes += textEncoder.encode(text).byteLength;
  if (budget.textBytes > CHAT_COMPLETION_LIMITS.textBytes) {
    throw new InvalidChatCompletionError(
      `message and attachment text must total at most ${CHAT_COMPLETION_LIMITS.textBytes} bytes`,
    );
  }
}

export function chatCompletionChunk(
  id: string,
  created: number,
  model: string,
  delta: Readonly<Record<string, string>>,
  finishReason: "stop" | null,
): string {
  return `data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
