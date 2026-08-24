import { SessionAgent, type SessionCheckpoint } from "../session/session-agent.ts";
import type { SessionAttachment } from "../session/session-turn.ts";

export type ConversationMessage = Readonly<{
  role: "user" | "assistant";
  content: string;
  attachments: readonly SessionAttachment[];
}>;

export type VisibleConversationMessage = Readonly<{
  role: "user" | "assistant";
  content: string;
}>;

export type ConversationHistorySnapshot = Readonly<{
  version: 1;
  messages: readonly VisibleConversationMessage[];
  committedLeafId: string | null;
}>;

export interface ConversationHistoryStore {
  load(conversationId: string): Promise<ConversationHistorySnapshot>;
  // Success is the turn commit point; abort before replacement must reject.
  save(
    conversationId: string,
    snapshot: ConversationHistorySnapshot,
    signal: AbortSignal,
  ): Promise<void>;
}

export function emptyConversationHistorySnapshot(): ConversationHistorySnapshot {
  return { version: 1, messages: [], committedLeafId: null };
}

export function validateConversationHistorySnapshot(
  value: ConversationHistorySnapshot,
): void {
  if (value.version !== 1 || !Array.isArray(value.messages)) {
    throw new Error("Invalid visible conversation history snapshot");
  }
  if (!value.messages.every(isVisibleConversationMessage)) {
    throw new Error("Invalid visible conversation history messages");
  }
  if (value.committedLeafId !== null && !value.committedLeafId.trim()) {
    throw new Error("Invalid committed Pi session leaf");
  }
  if ((value.messages.length === 0) !== (value.committedLeafId === null)) {
    throw new Error("Visible conversation history and committed Pi leaf disagree");
  }
  if (
    value.messages.length % 2 !== 0 ||
    value.messages.some((message, index) =>
      message.role !== (index % 2 === 0 ? "user" : "assistant")
    )
  ) {
    throw new Error("Visible conversation history is not a sequence of committed turns");
  }
}

export type ConversationTurn = Readonly<{
  conversationId: string;
  deltas: AsyncIterable<string>;
  abort(): Promise<void>;
}>;

export class ConversationConflictError extends Error {
  override readonly name = "ConversationConflictError";
}

type ConversationOptions = Readonly<{
  conversationId: string;
  history: readonly VisibleConversationMessage[];
  historyStore: ConversationHistoryStore;
  createAgent(): Promise<SessionAgent>;
  evict(): void;
}>;

export class Conversation {
  readonly conversationId: string;
  readonly #historyStore: ConversationHistoryStore;
  readonly #createAgent: () => Promise<SessionAgent>;
  readonly #evict: () => void;
  #history: VisibleConversationMessage[];
  #agent: SessionAgent | undefined;
  #active = false;

  constructor(options: ConversationOptions) {
    this.conversationId = options.conversationId;
    this.#history = options.history.map(({ role, content }) => ({ role, content }));
    this.#historyStore = options.historyStore;
    this.#createAgent = options.createAgent;
    this.#evict = options.evict;
  }

  async start(messages: readonly ConversationMessage[]): Promise<ConversationTurn> {
    if (this.#active) {
      throw new ConversationConflictError("Conversation already has an active turn");
    }

    const lastMessage = messages.at(-1);
    if (!lastMessage || lastMessage.role !== "user") {
      throw new Error("Last conversation message must be a user message");
    }
    if (!sameVisibleHistory(messages.slice(0, -1), this.#history)) {
      throw new ConversationConflictError(
        "Visible conversation path does not match the persistent session",
      );
    }
    const userMessage = snapshotUserMessage(lastMessage);

    this.#active = true;
    try {
      this.#agent ??= await this.#createAgent();
      if (this.#agent.conversationId !== this.conversationId) {
        throw new Error("Conversation agent identity does not match the conversation");
      }
      return new ActiveConversationTurn(this, this.#agent, userMessage, this.#agent.checkpoint());
    } catch (error) {
      try {
        this.#agent?.dispose();
      } finally {
        this.#agent = undefined;
        this.#active = false;
        this.#evict();
      }
      throw error;
    }
  }

  async commit(
    userMessage: ConversationMessage,
    assistantContent: string,
    committedLeafId: string | null,
    signal: AbortSignal,
  ): Promise<void> {
    const messages: VisibleConversationMessage[] = [
      ...this.#history,
      { role: "user", content: userMessage.content },
      { role: "assistant", content: assistantContent },
    ];
    const snapshot: ConversationHistorySnapshot = {
      version: 1,
      messages,
      committedLeafId,
    };
    validateConversationHistorySnapshot(snapshot);
    await this.#historyStore.save(this.conversationId, snapshot, signal);
    this.#history = messages;
    this.#active = false;
  }

  async rollback(agent: SessionAgent, checkpoint: SessionCheckpoint): Promise<void> {
    try {
      await agent.rollback(checkpoint);
    } finally {
      try {
        agent.dispose();
      } finally {
        this.#agent = undefined;
        this.#evict();
      }
    }
  }
}

class ActiveConversationTurn implements ConversationTurn {
  readonly conversationId: string;
  readonly deltas: AsyncIterable<string>;
  readonly #conversation: Conversation;
  readonly #agent: SessionAgent;
  readonly #userMessage: ConversationMessage;
  readonly #checkpoint: SessionCheckpoint;
  #phase: "responding" | "saving" | "finished" = "responding";
  readonly #abortController = new AbortController();
  #savePromise: Promise<void> | undefined;
  #rollbackPromise: Promise<void> | undefined;

  constructor(
    conversation: Conversation,
    agent: SessionAgent,
    userMessage: ConversationMessage,
    checkpoint: SessionCheckpoint,
  ) {
    this.conversationId = conversation.conversationId;
    this.#conversation = conversation;
    this.#agent = agent;
    this.#userMessage = userMessage;
    this.#checkpoint = checkpoint;
    this.deltas = this.#respond();
  }

  async abort(): Promise<void> {
    if (this.#rollbackPromise) return this.#rollbackPromise;
    if (this.#phase === "finished") return;
    if (this.#phase === "responding") return this.#rollback();

    this.#abortController.abort();
    const savePromise = this.#savePromise;
    if (!savePromise) return this.#rollback();
    try {
      await savePromise;
    } catch {
      return this.#rollback();
    }
  }

  async *#respond(): AsyncIterable<string> {
    if (this.#phase === "finished") return;
    let output = "";
    try {
      for await (const delta of this.#agent.respond({
        conversationId: this.conversationId,
        userText: this.#userMessage.content,
        attachments: this.#userMessage.attachments,
      })) {
        output += delta;
        yield delta;
      }

      if (this.#phase !== "responding") return;
      this.#phase = "saving";
      const committedCheckpoint = this.#agent.checkpoint();
      this.#savePromise = this.#conversation.commit(
        this.#userMessage,
        output,
        committedCheckpoint.leafId,
        this.#abortController.signal,
      );
      await this.#savePromise;
      this.#phase = "finished";
    } catch (error) {
      try {
        await this.#rollback();
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "Conversation turn failed and Pi session rollback also failed",
        );
      }
      throw error;
    } finally {
      if (this.#phase !== "finished") await this.#rollback();
    }
  }

  #rollback(): Promise<void> {
    if (this.#rollbackPromise) return this.#rollbackPromise;
    if (this.#phase === "finished") return Promise.resolve();

    this.#phase = "finished";
    this.#rollbackPromise = this.#conversation.rollback(this.#agent, this.#checkpoint);
    return this.#rollbackPromise;
  }
}

function isVisibleConversationMessage(
  value: unknown,
): value is VisibleConversationMessage {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    (record.role === "user" || record.role === "assistant") &&
    typeof record.content === "string"
  );
}

function snapshotUserMessage(message: ConversationMessage): ConversationMessage {
  return {
    role: "user",
    content: message.content,
    attachments: message.attachments.map(({ name, text }) => ({ name, text })),
  };
}

function sameVisibleHistory(
  incoming: readonly ConversationMessage[],
  stored: readonly VisibleConversationMessage[],
): boolean {
  if (incoming.length !== stored.length) return false;
  return incoming.every((message, index) => {
    const expected = stored[index];
    return expected?.role === message.role && expected.content === message.content;
  });
}
