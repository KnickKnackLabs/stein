import type {
  ConversationAttachment,
  ConversationMessage,
} from "../conversation/conversation-registry.ts";

export class InvalidChatRequestError extends Error {}

export const OPENAI_CHAT_LIMITS = Object.freeze({
  messages: 200,
  attachments: 20,
  textBytes: 2 * 1024 * 1024,
});

export function parseChatCompletionRequest(value: unknown, modelId: string): ConversationMessage[] {
  if (!isRecord(value)) throw new InvalidChatRequestError("Request body must be an object");
  if (value.stream !== true) throw new InvalidChatRequestError("Only streaming chat completions are supported");
  if (value.model !== modelId) throw new InvalidChatRequestError(`model must be ${JSON.stringify(modelId)}`);
  if (!Array.isArray(value.messages) || value.messages.length === 0) {
    throw new InvalidChatRequestError("messages must be a non-empty array");
  }
  if (value.messages.length > OPENAI_CHAT_LIMITS.messages) {
    throw new InvalidChatRequestError(`messages must contain at most ${OPENAI_CHAT_LIMITS.messages} entries`);
  }

  const budget: RequestBudget = { attachmentCount: 0, textBytes: 0 };
  const messages = value.messages.map((raw, index) => parseMessage(raw, index, budget));
  if (messages.at(-1)?.role !== "user") {
    throw new InvalidChatRequestError("Last message must be a user message");
  }
  return messages;
}

interface RequestBudget {
  attachmentCount: number;
  textBytes: number;
}

function parseMessage(raw: unknown, index: number, budget: RequestBudget): ConversationMessage {
  if (!isRecord(raw) || (raw.role !== "user" && raw.role !== "assistant") || typeof raw.content !== "string") {
    throw new InvalidChatRequestError(`messages[${index}] must contain a user or assistant role and string content`);
  }

  addTextToBudget(raw.content, budget);
  const attachments = parseAttachments(raw.attachments, raw.role, index, budget);
  if (raw.role === "user" && !raw.content.trim() && !attachments.some((attachment) => attachment.text.trim())) {
    throw new InvalidChatRequestError(`messages[${index}] user turn must contain text or non-empty attached text`);
  }
  return { role: raw.role, content: raw.content, attachments };
}

function parseAttachments(
  value: unknown,
  role: ConversationMessage["role"],
  messageIndex: number,
  budget: RequestBudget,
): ConversationAttachment[] {
  if (value === undefined) return [];
  if (role !== "user" || !Array.isArray(value)) {
    throw new InvalidChatRequestError(`messages[${messageIndex}].attachments must be an array on a user message`);
  }

  addAttachmentsToBudget(value.length, budget);
  return value.map((attachment, attachmentIndex) => {
    if (!isRecord(attachment) || typeof attachment.name !== "string" || !attachment.name.trim() || typeof attachment.text !== "string") {
      throw new InvalidChatRequestError(`messages[${messageIndex}].attachments[${attachmentIndex}] must contain name and text`);
    }
    addTextToBudget(attachment.name, budget);
    addTextToBudget(attachment.text, budget);
    return { name: attachment.name, text: attachment.text };
  });
}

function addAttachmentsToBudget(count: number, budget: RequestBudget): void {
  budget.attachmentCount += count;
  if (budget.attachmentCount > OPENAI_CHAT_LIMITS.attachments) {
    throw new InvalidChatRequestError(`messages must contain at most ${OPENAI_CHAT_LIMITS.attachments} attachments`);
  }
}

function addTextToBudget(text: string, budget: RequestBudget): void {
  budget.textBytes += new TextEncoder().encode(text).byteLength;
  if (budget.textBytes > OPENAI_CHAT_LIMITS.textBytes) {
    throw new InvalidChatRequestError(`message and attachment text must total at most ${OPENAI_CHAT_LIMITS.textBytes} bytes`);
  }
}

export function sseChunk(
  id: string,
  created: number,
  model: string,
  delta: Record<string, string>,
  finishReason: string | null,
): string {
  return `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
}

export function errorResponse(message: string, type: string, status: number): Response {
  return jsonResponse({ error: { message, type } }, status);
}

export function jsonResponse(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
