import { describe, expect, test } from "bun:test";
import {
  ConversationConflictError,
  ConversationRegistry,
  type ConversationHistoryStore,
  type ConversationIdentity,
  type ConversationMessage,
  type VisibleConversationMessage,
} from "../../src/conversation/conversation-registry.ts";
import { SessionAgent, type PiSession } from "../../src/session/session-agent.ts";

class FakeSession implements PiSession {
  readonly #listeners = new Set<(event: unknown) => void>();
  chunks = ["hello", " world"];
  failure: Error | undefined;
  blocker: Promise<void> | undefined;
  disposed = 0;

  subscribe(listener: (event: unknown) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  async prompt(): Promise<void> {
    if (this.blocker) await this.blocker;
    for (const delta of this.chunks) {
      for (const listener of this.#listeners) {
        listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta } });
      }
    }
    if (this.failure) throw this.failure;
  }
  dispose(): void { this.disposed += 1; }
}

class MemoryHistoryStore implements ConversationHistoryStore {
  readonly histories = new Map<string, readonly VisibleConversationMessage[]>();

  async load(conversationId: string): Promise<readonly VisibleConversationMessage[]> {
    return this.histories.get(conversationId) ?? [];
  }

  async save(conversationId: string, history: readonly VisibleConversationMessage[]): Promise<void> {
    this.histories.set(conversationId, structuredClone(history));
  }
}

function harness(
  configure?: (session: FakeSession, index: number) => void,
  historyStore = new MemoryHistoryStore(),
) {
  const identities: ConversationIdentity[] = [];
  const sessions: FakeSession[] = [];
  const registry = new ConversationRegistry(async (identity) => {
    identities.push(identity);
    const session = new FakeSession();
    configure?.(session, sessions.length);
    sessions.push(session);
    return new SessionAgent({
      conversationId: identity.conversationId,
      systemPrompt: "Fictional prompt",
      model: { provider: "test", id: "deterministic" },
      storage: {
        sessionFile: `/tmp/${identity.conversationId}.jsonl`,
        sessionDirectory: "/tmp",
        workspaceDirectory: "/tmp/workspace",
      },
      session,
    });
  }, historyStore);
  return { registry, identities, sessions, historyStore };
}

const user = (
  content: string,
  attachments: ConversationMessage["attachments"] = [],
): ConversationMessage => ({ role: "user", content, attachments });
const assistant = (content: string): ConversationMessage => ({ role: "assistant", content, attachments: [] });

async function consume(turn: Awaited<ReturnType<ConversationRegistry["start"]>>): Promise<string> {
  let output = "";
  for await (const delta of turn.deltas) output += delta;
  return output;
}

describe("ConversationRegistry", () => {
  test("reuses one persistent conversation and isolates another identity", async () => {
    const { registry, identities, sessions } = harness();
    expect(await consume(await registry.start("user", "chat", [user("first")]))).toBe("hello world");
    expect(await consume(await registry.start("user", "chat", [user("first"), assistant("hello world"), user("second")]))).toBe("hello world");
    await consume(await registry.start("user", "other-chat", [user("separate")]));
    expect(sessions).toHaveLength(2);
    expect(identities[0]?.conversationId).not.toBe(identities[1]?.conversationId);
  });

  test("reloads visible history after a registry restart", async () => {
    const historyStore = new MemoryHistoryStore();
    const first = harness(undefined, historyStore);
    await consume(await first.registry.start("user", "chat", [user("first")]));

    const restarted = harness(undefined, historyStore);
    expect(await consume(await restarted.registry.start("user", "chat", [
      user("first"),
      assistant("hello world"),
      user("second"),
    ]))).toBe("hello world");
    expect(restarted.sessions).toHaveLength(1);
  });

  test("does not advance persisted history when a turn fails", async () => {
    const historyStore = new MemoryHistoryStore();
    const failing = harness((session) => { session.failure = new Error("deterministic failure"); }, historyStore);
    await expect(consume(await failing.registry.start("user", "chat", [user("first")]))).rejects.toThrow("deterministic failure");

    const restarted = harness(undefined, historyStore);
    expect(await consume(await restarted.registry.start("user", "chat", [user("retry")]))).toBe("hello world");
  });

  test("does not require prior current-turn attachments in visible history", async () => {
    const { registry } = harness();
    await consume(await registry.start("user", "chat", [
      user("first", [{ name: "fictional.txt", text: "attached text" }]),
    ]));
    expect(await consume(await registry.start("user", "chat", [
      user("first"),
      assistant("hello world"),
      user("second"),
    ]))).toBe("hello world");
  });

  test("rejects a visible branch from persistent history", async () => {
    const { registry } = harness();
    await consume(await registry.start("user", "chat", [user("first")]));
    await expect(registry.start("user", "chat", [user("different"), assistant("hello world"), user("next")]))
      .rejects.toThrow(ConversationConflictError);
  });

  test("rejects concurrent turns", async () => {
    let release: (() => void) | undefined;
    const blocker = new Promise<void>((resolve) => { release = resolve; });
    const { registry } = harness((session) => { session.blocker = blocker; });
    const first = await registry.start("user", "chat", [user("first")]);
    const consuming = consume(first);
    await Promise.resolve();
    await expect(registry.start("user", "chat", [user("second")])).rejects.toThrow(ConversationConflictError);
    release?.();
    await consuming;
  });

  test("disposes a failed session and permits a clean retry", async () => {
    const { registry, sessions } = harness((session, index) => {
      if (index === 0) session.failure = new Error("deterministic failure");
    });
    await expect(consume(await registry.start("user", "chat", [user("first")]))).rejects.toThrow("deterministic failure");
    expect(sessions[0]?.disposed).toBe(1);
    expect(await consume(await registry.start("user", "chat", [user("retry")]))).toBe("hello world");
    expect(sessions).toHaveLength(2);
  });
});
