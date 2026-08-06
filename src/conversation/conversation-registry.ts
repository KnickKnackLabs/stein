import { createHash } from "node:crypto";
import { SessionAgent } from "../session/session-agent.ts";
import {
  Conversation,
  type ConversationHistoryStore,
  type ConversationMessage,
  type ConversationTurn,
} from "./conversation.ts";

export type ConversationIdentity = Readonly<{
  conversationId: string;
  userId: string;
  chatId: string;
}>;

export type ConversationAgentFactory = (
  identity: ConversationIdentity,
) => Promise<SessionAgent>;

export class ConversationRegistry {
  readonly #createAgent: ConversationAgentFactory;
  readonly #historyStore: ConversationHistoryStore;
  readonly #conversations = new Map<string, Promise<Conversation>>();

  constructor(createAgent: ConversationAgentFactory, historyStore: ConversationHistoryStore) {
    this.#createAgent = createAgent;
    this.#historyStore = historyStore;
  }

  async start(
    userId: string,
    chatId: string,
    messages: readonly ConversationMessage[],
  ): Promise<ConversationTurn> {
    const identity = conversationIdentity(userId, chatId);
    const conversation = await this.#conversation(identity);
    return conversation.start(messages);
  }

  #conversation(identity: ConversationIdentity): Promise<Conversation> {
    const existing = this.#conversations.get(identity.conversationId);
    if (existing) return existing;

    let created: Promise<Conversation>;
    created = this.#historyStore.load(identity.conversationId).then((history) =>
      new Conversation({
        conversationId: identity.conversationId,
        history,
        historyStore: this.#historyStore,
        createAgent: () => this.#createAgent(identity),
        evict: () => {
          if (this.#conversations.get(identity.conversationId) === created) {
            this.#conversations.delete(identity.conversationId);
          }
        },
      })
    );
    this.#conversations.set(identity.conversationId, created);
    created.catch(() => {
      if (this.#conversations.get(identity.conversationId) === created) {
        this.#conversations.delete(identity.conversationId);
      }
    });
    return created;
  }
}

function conversationIdentity(userId: string, chatId: string): ConversationIdentity {
  requireIdentityPart("userId", userId);
  requireIdentityPart("chatId", chatId);
  const conversationId = createHash("sha256")
    .update(JSON.stringify([userId, chatId]))
    .digest("hex");
  return { conversationId, userId, chatId };
}

function requireIdentityPart(name: string, value: string): void {
  if (!value.trim()) throw new Error(`${name} must not be empty`);
}
