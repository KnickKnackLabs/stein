import type { ConversationMessage } from "../conversation/conversation.ts";

export type AttachmentNormalizerInput = Readonly<{
  messageIndex: number;
  content: string;
  attachments: ConversationMessage["attachments"];
}>;

export type AttachmentNormalizerResult = Readonly<{
  content: string;
  attachments: ConversationMessage["attachments"];
}>;

export type AttachmentNormalizer = (input: AttachmentNormalizerInput) => AttachmentNormalizerResult;
