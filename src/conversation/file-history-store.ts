import { randomUUID } from "node:crypto";
import { renameSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  type ConversationHistorySnapshot,
  type ConversationHistoryStore,
  emptyConversationHistorySnapshot,
  validateConversationHistorySnapshot,
} from "./conversation.ts";

export class FileConversationHistoryStore implements ConversationHistoryStore {
  readonly #directory: string;

  constructor(directory: string) {
    if (!isAbsolute(directory)) {
      throw new Error("Conversation history directory must be absolute");
    }
    this.#directory = directory;
  }

  async load(conversationId: string): Promise<ConversationHistorySnapshot> {
    let contents: string;
    try {
      contents = await readFile(this.#path(conversationId), "utf8");
    } catch (error) {
      if (isMissing(error)) return emptyConversationHistorySnapshot();
      throw error;
    }

    let value: unknown;
    try {
      value = JSON.parse(contents);
    } catch (error) {
      throw new Error("Invalid visible conversation history JSON", { cause: error });
    }
    if (Array.isArray(value)) {
      throw new Error("Legacy array-only visible history requires an explicit migration or reset");
    }
    if (!isConversationHistorySnapshot(value)) {
      throw new Error(`Invalid visible conversation history snapshot for ${conversationId}`);
    }
    validateConversationHistorySnapshot(value);
    return {
      version: 1,
      messages: value.messages.map(({ role, content }) => ({ role, content })),
      committedLeafId: value.committedLeafId,
    };
  }

  async save(
    conversationId: string,
    snapshot: ConversationHistorySnapshot,
    signal: AbortSignal,
  ): Promise<void> {
    const destination = this.#path(conversationId);
    validateConversationHistorySnapshot(snapshot);

    signal.throwIfAborted();
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    signal.throwIfAborted();
    await chmod(this.#directory, 0o700);
    signal.throwIfAborted();
    const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      // Keep cancellation and atomic replacement in one synchronous turn.
      signal.throwIfAborted();
      renameSync(temporary, destination);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  #path(conversationId: string): string {
    if (!/^[a-f0-9]{64}$/.test(conversationId)) {
      throw new Error("Conversation identity must be a SHA-256 digest");
    }
    return join(this.#directory, `${conversationId}.visible-history.json`);
  }
}

function isConversationHistorySnapshot(value: unknown): value is ConversationHistorySnapshot {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.version === 1 &&
    Array.isArray(record.messages) &&
    (record.committedLeafId === null || typeof record.committedLeafId === "string")
  );
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
