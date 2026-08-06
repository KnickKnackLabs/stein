import { describe, expect, test } from "bun:test";
import {
  ConversationConflictError,
  ConversationRegistry,
  type ConversationHistoryStore,
  type ConversationIdentity,
  type ConversationMessage,
  type VisibleConversationMessage,
} from "../../src/conversation/conversation-registry.ts";
import {
  SessionAgent,
  type PiSession,
  type PiSessionManager,
} from "../../src/session/session-agent.ts";

class FakeSessionManager implements PiSessionManager {
  leafId: string | null = null;
  readonly branches: Array<string | null> = [];
  readonly customEntries: Array<{ customType: string; data: unknown }> = [];
  #nextId = 0;

  getLeafId(): string | null { return this.leafId; }
  branch(entryId: string): void { this.branches.push(entryId); this.leafId = entryId; }
  resetLeaf(): void { this.branches.push(null); this.leafId = null; }
  appendCustomEntry(customType: string, data?: unknown): string {
    this.customEntries.push({ customType, data });
    this.leafId = `rollback-${++this.#nextId}`;
    return this.leafId;
  }
  advance(): void { this.leafId = `turn-${++this.#nextId}`; }
}

class FakeSession implements PiSession {
  readonly sessionManager = new FakeSessionManager();
  readonly #listeners = new Set<(event: unknown) => void>();
  chunks = ["hello", " world"];
  failure: Error | undefined;
  blocker: Promise<void> | undefined;
  releaseOnAbort: (() => void) | undefined;
  aborted = 0;
  disposed = 0;

  subscribe(listener: (event: unknown) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  async prompt(): Promise<void> {
    this.sessionManager.advance();
    if (this.blocker) await this.blocker;
    if (this.aborted > 0) throw new Error("deterministic abort");
    for (const delta of this.chunks) {
      for (const listener of this.#listeners) {
        listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta } });
      }
    }
    if (this.failure) throw this.failure;
  }
  async abort(): Promise<void> { this.aborted += 1; this.releaseOnAbort?.(); }
  dispose(): void { this.disposed += 1; }
}

class MemoryHistoryStore implements ConversationHistoryStore {
  readonly histories = new Map<string, readonly VisibleConversationMessage[]>();
  saveFailure: Error | undefined;

  async load(conversationId: string): Promise<readonly VisibleConversationMessage[]> {
    return this.histories.get(conversationId) ?? [];
  }

  async save(conversationId: string, history: readonly VisibleConversationMessage[]): Promise<void> {
    if (this.saveFailure) throw this.saveFailure;
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

  test("rolls back the Pi session when a model turn fails", async () => {
    const historyStore = new MemoryHistoryStore();
    const failing = harness((session) => { session.failure = new Error("deterministic failure"); }, historyStore);
    await expect(consume(await failing.registry.start("user", "chat", [user("first")]))).rejects.toThrow("deterministic failure");

    expect(failing.sessions[0]?.sessionManager.branches).toEqual([null]);
    expect(failing.sessions[0]?.sessionManager.customEntries[0]).toEqual({
      customType: "stein.turn_rollback",
      data: { checkpoint: null },
    });
    const restarted = harness(undefined, historyStore);
    expect(await consume(await restarted.registry.start("user", "chat", [user("retry")]))).toBe("hello world");
  });

  test("rolls back the Pi session when visible-history persistence fails", async () => {
    const historyStore = new MemoryHistoryStore();
    historyStore.saveFailure = new Error("deterministic history failure");
    const failed = harness(undefined, historyStore);

    await expect(consume(await failed.registry.start("user", "chat", [user("first")]))).rejects.toThrow("deterministic history failure");
    expect(failed.sessions[0]?.sessionManager.branches).toEqual([null]);
    expect(failed.sessions[0]?.disposed).toBe(1);
    expect(historyStore.histories.size).toBe(0);
  });

  test("rolls back the Pi session when an active turn is aborted", async () => {
    let release = () => {};
    const blocker = new Promise<void>((resolve) => { release = resolve; });
    const active = harness((session) => {
      session.blocker = blocker;
      session.releaseOnAbort = release;
    });
    const turn = await active.registry.start("user", "chat", [user("first")]);
    const consuming = consume(turn);
    await Promise.resolve();

    await turn.abort();

    await expect(consuming).rejects.toThrow("deterministic abort");
    expect(active.sessions[0]?.sessionManager.branches).toEqual([null]);
    expect(active.sessions[0]?.sessionManager.customEntries).toHaveLength(1);
    expect(active.sessions[0]?.disposed).toBe(1);
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
