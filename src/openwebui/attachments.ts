import type { AttachmentNormalizer } from "../openai/attachment-normalizer.ts";
import { InvalidChatCompletionError } from "../openai/chat-completion.ts";

export const kklOpenWebUiAttachmentNormalizer: AttachmentNormalizer = ({
  messageIndex,
  content,
  attachments: structured,
}) => {
  const embedded: Array<{ name: string; text: string }> = [];
  let matched = false;
  const stripped = content.replace(
    /<attached_file name="([^"]*)">([\s\S]*?)<\/attached_file>/g,
    (_full, rawName: string, text: string) => {
      matched = true;
      const name = unescapeHtmlEntities(rawName).trim();
      if (!name) {
        throw new InvalidChatCompletionError(
          `messages[${messageIndex}] embedded attachment must contain a name`,
        );
      }
      embedded.push({ name, text });
      return "";
    },
  );
  return {
    content: matched
      ? stripped.replace(/<\/?attached_files>\s*/g, "").trim()
      : content,
    attachments: [...embedded, ...structured],
  };
};

function unescapeHtmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}
