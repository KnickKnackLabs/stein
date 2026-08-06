import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { ConversationHistoryStore, VisibleConversationMessage } from "./conversation-registry.ts";

export class FileConversationHistoryStore implements ConversationHistoryStore {
  readonly #directory: string;

  constructor(directory: string) {
    if (!isAbsolute(directory)) throw new Error("Conversation history directory must be absolute");
    this.#directory = directory;
  }

  async load(conversationId: string): Promise<readonly VisibleConversationMessage[]> {
    let contents: string;
    try {
      contents = await readFile(this.#path(conversationId), "utf8");
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    const value: unknown = JSON.parse(contents);
    if (!Array.isArray(value) || !value.every(isVisibleMessage)) {
      throw new Error(`Invalid visible conversation history for ${conversationId}`);
    }
    return value.map(({ role, content }) => ({ role, content }));
  }

  async save(conversationId: string, history: readonly VisibleConversationMessage[]): Promise<void> {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    await chmod(this.#directory, 0o700);
    const destination = this.#path(conversationId);
    const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(history, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      await rename(temporary, destination);
      await chmod(destination, 0o600);
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
  }

  #path(conversationId: string): string {
    if (!/^[a-f0-9]{64}$/.test(conversationId)) {
      throw new Error("Conversation identity must be a SHA-256 digest");
    }
    return join(this.#directory, `${conversationId}.visible-history.json`);
  }
}

function isVisibleMessage(value: unknown): value is VisibleConversationMessage {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (record.role === "user" || record.role === "assistant") && typeof record.content === "string";
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
