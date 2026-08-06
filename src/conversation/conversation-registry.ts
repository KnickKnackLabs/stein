import { createHash } from "node:crypto";
import type { SessionAgent } from "../session/session-agent.ts";

export type ConversationIdentity = Readonly<{
  conversationId: string;
  userId: string;
  chatId: string;
}>;

export type AgentFactory = (identity: ConversationIdentity) => Promise<SessionAgent>;

export type ConversationAttachment = Readonly<{ name: string; text: string }>;

export type ConversationMessage = Readonly<{
  role: "user" | "assistant";
  content: string;
  attachments: readonly ConversationAttachment[];
}>;

export type VisibleConversationMessage = Readonly<{
  role: "user" | "assistant";
  content: string;
}>;

export interface ConversationHistoryStore {
  load(conversationId: string): Promise<readonly VisibleConversationMessage[]>;
  save(conversationId: string, history: readonly VisibleConversationMessage[]): Promise<void>;
}

export type ConversationTurn = Readonly<{
  conversationId: string;
  deltas: AsyncIterable<string>;
  abort(): Promise<void>;
}>;

type Entry = {
  agent?: SessionAgent;
  history: VisibleConversationMessage[];
  busy: boolean;
};

export class ConversationConflictError extends Error {}

export class ConversationRegistry {
  readonly #createAgent: AgentFactory;
  readonly #historyStore: ConversationHistoryStore;
  readonly #entries = new Map<string, Promise<Entry>>();

  constructor(createAgent: AgentFactory, historyStore: ConversationHistoryStore) {
    this.#createAgent = createAgent;
    this.#historyStore = historyStore;
  }

  async start(userId: string, chatId: string, messages: readonly ConversationMessage[]): Promise<ConversationTurn> {
    const conversationId = conversationHash(userId, chatId);
    const entry = await this.#entry(conversationId);
    if (entry.busy) {
      throw new ConversationConflictError("Conversation already has an active turn");
    }

    const userMessage = messages.at(-1);
    if (!userMessage || userMessage.role !== "user") {
      throw new Error("Last conversation message must be a user message");
    }
    if (!sameHistory(messages.slice(0, -1), entry.history)) {
      throw new ConversationConflictError("Visible conversation path does not match the persistent session");
    }

    entry.busy = true;
    let checkpoint: ReturnType<SessionAgent["checkpoint"]>;
    try {
      entry.agent ??= await this.#createAgent({ conversationId, userId, chatId });
      checkpoint = entry.agent.checkpoint();
    } catch (error) {
      entry.busy = false;
      this.#entries.delete(conversationId);
      entry.agent?.dispose();
      throw error;
    }

    let phase: "active" | "committing" | "committed" | "removed" = "active";
    const rollbackAndRemove = async (force = false) => {
      if (phase === "removed" || phase === "committed") return;
      if (phase === "committing" && !force) return;
      phase = "removed";
      this.#entries.delete(conversationId);
      try {
        await entry.agent!.rollback(checkpoint);
      } finally {
        entry.agent!.dispose();
      }
    };
    const beginCommit = () => {
      if (phase !== "active") return false;
      phase = "committing";
      return true;
    };
    const finishCommit = () => {
      if (phase !== "committing") throw new Error("Conversation turn left the committing phase");
      phase = "committed";
    };
    const deltas = this.#run(
      entry,
      conversationId,
      userMessage,
      rollbackAndRemove,
      beginCommit,
      finishCommit,
    );
    const abort = () => rollbackAndRemove(false);
    return { conversationId, deltas, abort };
  }

  async *#run(
    entry: Entry,
    conversationId: string,
    userMessage: ConversationMessage,
    rollbackAndRemove: (force?: boolean) => Promise<void>,
    beginCommit: () => boolean,
    finishCommit: () => void,
  ): AsyncIterable<string> {
    let output = "";
    try {
      for await (const delta of entry.agent!.respond({
        conversationId,
        userText: userMessage.content,
        attachments: userMessage.attachments,
      })) {
        output += delta;
        yield delta;
      }
      if (!beginCommit()) return;
      const history = [
        ...entry.history,
        { role: userMessage.role, content: userMessage.content } as const,
        { role: "assistant", content: output } as const,
      ];
      await this.#historyStore.save(conversationId, history);
      entry.history = history;
      entry.busy = false;
      finishCommit();
    } catch (error) {
      try {
        await rollbackAndRemove(true);
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], "Conversation turn failed and Pi session rollback also failed");
      }
      throw error;
    }
  }

  #entry(conversationId: string): Promise<Entry> {
    const existing = this.#entries.get(conversationId);
    if (existing) return existing;
    const created = this.#historyStore.load(conversationId).then((history) => ({
      history: [...history],
      busy: false,
    }));
    this.#entries.set(conversationId, created);
    created.catch(() => this.#entries.delete(conversationId));
    return created;
  }
}

function conversationHash(userId: string, chatId: string): string {
  return createHash("sha256").update(userId).update("\0").update(chatId).digest("hex");
}

function sameHistory(
  incoming: readonly ConversationMessage[],
  stored: readonly VisibleConversationMessage[],
): boolean {
  const visible = incoming.map(({ role, content }) => ({ role, content }));
  return JSON.stringify(visible) === JSON.stringify(stored);
}
