import { describe, expect, test } from "bun:test";
import {
  ConversationConflictError,
  type ConversationHistoryStore,
  type ConversationMessage,
  type VisibleConversationMessage,
} from "../../src/conversation/conversation.ts";
import {
  ConversationRegistry,
  type ConversationIdentity,
} from "../../src/conversation/conversation-registry.ts";
import { SessionAgent } from "../../src/session/session-agent.ts";
import { FakePiSession } from "../support/fake-pi-session.ts";

class MemoryHistoryStore implements ConversationHistoryStore {
  readonly histories = new Map<string, readonly VisibleConversationMessage[]>();
  failure: unknown;
  shouldFail = false;
  saveGate: Promise<void> | undefined;
  saveStarted: (() => void) | undefined;

  async load(conversationId: string): Promise<readonly VisibleConversationMessage[]> {
    return structuredClone(this.histories.get(conversationId) ?? []);
  }

  async save(
    conversationId: string,
    history: readonly VisibleConversationMessage[],
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    this.saveStarted?.();
    if (this.saveGate) await this.saveGate;
    signal.throwIfAborted();
    if (this.shouldFail) throw this.failure;
    this.histories.set(conversationId, structuredClone(history));
  }
}

function harness(
  configure?: (session: FakePiSession, index: number) => void,
  historyStore = new MemoryHistoryStore(),
) {
  const identities: ConversationIdentity[] = [];
  const sessions: FakePiSession[] = [];
  const registry = new ConversationRegistry(async (identity) => {
    identities.push(identity);
    const session = new FakePiSession();
    session.defaultResponse = ["hello", " world"];
    configure?.(session, sessions.length);
    sessions.push(session);
    return new SessionAgent({ conversationId: identity.conversationId, session });
  }, historyStore);
  return { registry, identities, sessions, historyStore };
}

const user = (
  content: string,
  attachments: ConversationMessage["attachments"] = [],
): ConversationMessage => ({ role: "user", content, attachments });
const assistant = (content: string): ConversationMessage => ({
  role: "assistant",
  content,
  attachments: [],
});

async function consume(deltas: AsyncIterable<string>): Promise<string> {
  let output = "";
  for await (const delta of deltas) output += delta;
  return output;
}

describe("ConversationRegistry", () => {
  test("commits and reuses one conversation while isolating another", async () => {
    const { registry, identities, sessions, historyStore } = harness();
    const first = await registry.start("user", "chat", [user("first")]);
    expect(await consume(first.deltas)).toBe("hello world");
    expect(historyStore.histories.get(first.conversationId)).toEqual([
      { role: "user", content: "first" },
      { role: "assistant", content: "hello world" },
    ]);

    const second = await registry.start("user", "chat", [
      user("first"),
      assistant("hello world"),
      user("second"),
    ]);
    await consume(second.deltas);
    const separate = await registry.start("user", "other-chat", [user("separate")]);
    await consume(separate.deltas);

    expect(sessions).toHaveLength(2);
    expect(identities[0]?.conversationId).toBe(first.conversationId);
    expect(identities[0]?.conversationId).not.toBe(identities[1]?.conversationId);
  });

  test("reloads committed visible history after a registry restart", async () => {
    const historyStore = new MemoryHistoryStore();
    const first = harness(undefined, historyStore);
    const initial = await first.registry.start("user", "chat", [user("first")]);
    await consume(initial.deltas);

    const restarted = harness(undefined, historyStore);
    const continued = await restarted.registry.start("user", "chat", [
      user("first"),
      assistant("hello world"),
      user("second"),
    ]);

    expect(await consume(continued.deltas)).toBe("hello world");
    expect(restarted.sessions).toHaveLength(1);
  });

  test("rejects a divergent visible path and snapshots current attachments", async () => {
    const { registry, sessions } = harness();
    const attachments = [{ name: "fictional.txt", text: "attached text" }];
    const first = await registry.start("user", "chat", [user("first", attachments)]);
    attachments[0]!.text = "mutated after start";
    await consume(first.deltas);
    expect(JSON.parse(sessions[0]?.prompts[0] ?? "")).toEqual({
      userText: "first",
      attachments: [{ name: "fictional.txt", text: "attached text" }],
    });

    await expect(registry.start("user", "chat", [
      user("different"),
      assistant("hello world"),
      user("next"),
    ])).rejects.toThrow(ConversationConflictError);
  });

  test("rejects an overlapping turn until the active turn commits", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { registry } = harness((session) => { session.promptGate = gate; });
    const first = await registry.start("user", "chat", [user("first")]);
    const consuming = consume(first.deltas);
    await Promise.resolve();

    await expect(registry.start("user", "chat", [user("overlap")]))
      .rejects.toThrow(ConversationConflictError);
    release();
    await consuming;
  });

  test("rolls a failed model turn back before permitting retry", async () => {
    const { registry, sessions, historyStore } = harness((session, index) => {
      if (index === 0) {
        session.shouldFail = true;
        session.failure = new Error("deterministic model failure");
      }
    });
    const failed = await registry.start("user", "chat", [user("first")]);
    await expect(consume(failed.deltas)).rejects.toThrow("deterministic model failure");

    expect(sessions[0]?.sessionManager.branches).toEqual([null]);
    expect(sessions[0]?.sessionManager.customEntries[0]).toEqual({
      type: "stein.turn_rollback",
      data: { checkpoint: null },
    });
    expect(sessions[0]?.disposeCount).toBe(1);
    expect(historyStore.histories.size).toBe(0);

    const retry = await registry.start("user", "chat", [user("retry")]);
    expect(await consume(retry.deltas)).toBe("hello world");
    expect(sessions).toHaveLength(2);
  });

  test("keeps the conversation locked until rollback finishes", async () => {
    let releaseRollback = () => {};
    let markRollbackStarted = () => {};
    const rollbackGate = new Promise<void>((resolve) => { releaseRollback = resolve; });
    const rollbackStarted = new Promise<void>((resolve) => { markRollbackStarted = resolve; });
    const { registry } = harness((session, index) => {
      if (index === 0) {
        session.shouldFail = true;
        session.failure = new Error("deterministic model failure");
        session.abortGate = rollbackGate;
        session.abortStarted = markRollbackStarted;
      }
    });
    const failed = await registry.start("user", "chat", [user("first")]);
    const consuming = consume(failed.deltas);
    await rollbackStarted;

    await expect(registry.start("user", "chat", [user("retry too soon")]))
      .rejects.toThrow(ConversationConflictError);
    releaseRollback();
    await expect(consuming).rejects.toThrow("deterministic model failure");
    const retry = await registry.start("user", "chat", [user("retry")]);
    expect(await consume(retry.deltas)).toBe("hello world");
  });

  test("rolls back when visible-history persistence fails", async () => {
    const historyStore = new MemoryHistoryStore();
    historyStore.shouldFail = true;
    historyStore.failure = new Error("deterministic history failure");
    const { registry, sessions } = harness(undefined, historyStore);
    const failed = await registry.start("user", "chat", [user("first")]);

    await expect(consume(failed.deltas)).rejects.toThrow("deterministic history failure");
    expect(sessions[0]?.sessionManager.branches).toEqual([null]);
    expect(sessions[0]?.disposeCount).toBe(1);
    expect(historyStore.histories.size).toBe(0);
  });

  test("waits for rollback when aborted during visible-history save", async () => {
    let releaseSave = () => {};
    let markSaveStarted = () => {};
    let releaseRollback = () => {};
    let markRollbackStarted = () => {};
    const historyStore = new MemoryHistoryStore();
    historyStore.saveGate = new Promise<void>((resolve) => { releaseSave = resolve; });
    const saveStarted = new Promise<void>((resolve) => { markSaveStarted = resolve; });
    historyStore.saveStarted = markSaveStarted;
    const rollbackGate = new Promise<void>((resolve) => { releaseRollback = resolve; });
    const rollbackStarted = new Promise<void>((resolve) => { markRollbackStarted = resolve; });
    const { registry, sessions } = harness((session, index) => {
      if (index === 0) {
        session.abortGate = rollbackGate;
        session.abortStarted = markRollbackStarted;
      }
    }, historyStore);
    const active = await registry.start("user", "chat", [user("first")]);
    const consuming = consume(active.deltas);
    const failed = consuming.then(
      () => undefined,
      (error: unknown) => error,
    );
    await saveStarted;

    let abortFinished = false;
    const aborting = active.abort().then(() => { abortFinished = true; });
    await Promise.resolve();
    expect(abortFinished).toBe(false);
    expect(historyStore.histories.size).toBe(0);

    releaseSave();
    await rollbackStarted;
    await Promise.resolve();
    expect(abortFinished).toBe(false);
    releaseRollback();
    await aborting;
    expect(await failed).toHaveProperty("name", "AbortError");
    expect(sessions[0]?.sessionManager.branches).toEqual([null]);
    expect(sessions[0]?.disposeCount).toBe(1);
    expect(historyStore.histories.size).toBe(0);

    historyStore.saveGate = undefined;
    historyStore.saveStarted = undefined;
    const retry = await registry.start("user", "chat", [user("retry")]);
    expect(await consume(retry.deltas)).toBe("hello world");
    expect(sessions).toHaveLength(2);
  });

  test("rolls back explicit abort and stream cancellation", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const explicit = harness((session) => {
      session.promptGate = gate;
      session.releasePrompt = release;
    });
    const active = await explicit.registry.start("user", "chat", [user("first")]);
    const consuming = consume(active.deltas);
    await Promise.resolve();
    await active.abort();
    await expect(consuming).rejects.toThrow("deterministic abort");
    expect(explicit.sessions[0]?.sessionManager.branches).toEqual([null]);

    const cancelled = harness();
    const turn = await cancelled.registry.start("user", "chat", [user("first")]);
    const iterator = turn.deltas[Symbol.asyncIterator]();
    expect(await iterator.next()).toEqual({ value: "hello", done: false });
    await iterator.return?.();
    expect(cancelled.sessions[0]?.sessionManager.branches).toEqual([null]);
  });

  test("rejects empty identity parts before creating a session", async () => {
    const { registry, sessions } = harness();
    await expect(registry.start(" ", "chat", [user("first")])).rejects.toThrow("userId");
    await expect(registry.start("user", " ", [user("first")])).rejects.toThrow("chatId");
    expect(sessions).toHaveLength(0);
  });
});
