import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ConversationHistorySnapshot } from "../../src/conversation/conversation.ts";
import { FileConversationHistoryStore } from "../../src/conversation/file-history-store.ts";
import { openSessionManagerForRecovery } from "../../src/session/pi-session.ts";

const roots: string[] = [];
const activeSignal = (): AbortSignal => new AbortController().signal;
type SessionMessage = Parameters<SessionManager["appendMessage"]>[0];

type Harness = Readonly<{
  sessionDirectory: string;
  workspaceDirectory: string;
  sessionFile: string;
  historyStore: FileConversationHistoryStore;
  conversationId: string;
}>;

async function harness(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "ghl-conversation-recovery-"));
  roots.push(root);
  const sessionDirectory = join(root, "sessions");
  const workspaceDirectory = join(root, "workspace");
  await Promise.all([
    mkdir(sessionDirectory, { recursive: true }),
    mkdir(workspaceDirectory, { recursive: true }),
  ]);
  const conversationId = "a".repeat(64);
  return {
    sessionDirectory,
    workspaceDirectory,
    sessionFile: join(sessionDirectory, `${conversationId}.jsonl`),
    historyStore: new FileConversationHistoryStore(sessionDirectory),
    conversationId,
  };
}

function appendTurn(manager: SessionManager, label: string): string {
  manager.appendMessage({ role: "user", content: `${label} user`, timestamp: Date.now() });
  return manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: `${label} assistant` }],
    api: "openai-completions",
    provider: "test",
    model: "deterministic",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  } as SessionMessage);
}

function snapshot(label: string, committedLeafId: string): ConversationHistorySnapshot {
  return {
    version: 1,
    messages: [
      { role: "user", content: `${label} user` },
      { role: "assistant", content: `${label} assistant` },
    ],
    committedLeafId,
  };
}

function reopen(
  state: Harness,
  snapshot: ConversationHistorySnapshot,
): SessionManager {
  return openSessionManagerForRecovery(
    state.sessionFile,
    state.sessionDirectory,
    state.workspaceDirectory,
    {
      committedLeafId: snapshot.committedLeafId,
      committedMessageRoles: snapshot.messages.map(({ role }) => role),
    },
  );
}

function context(manager: SessionManager): string {
  return JSON.stringify(manager.buildSessionContext().messages);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("committed conversation recovery", () => {
  test("crash before snapshot replacement restores the previous committed leaf", async () => {
    const state = await harness();
    const manager = SessionManager.open(
      state.sessionFile,
      state.sessionDirectory,
      state.workspaceDirectory,
    );
    const committedLeafId = appendTurn(manager, "committed");
    await state.historyStore.save(
      state.conversationId,
      snapshot("committed", committedLeafId),
      activeSignal(),
    );
    const abandonedLeafId = appendTurn(manager, "abandoned");

    const stored = await state.historyStore.load(state.conversationId);
    const recovered = reopen(state, stored);

    expect(recovered.getLeafId()).toBe(committedLeafId);
    expect(recovered.getLeafId()).not.toBe(abandonedLeafId);
    expect(context(recovered)).toContain("committed assistant");
    expect(context(recovered)).not.toContain("abandoned assistant");
  });

  test("crash after snapshot replacement restores the new committed leaf", async () => {
    const state = await harness();
    const manager = SessionManager.open(
      state.sessionFile,
      state.sessionDirectory,
      state.workspaceDirectory,
    );
    appendTurn(manager, "first");
    const committedLeafId = appendTurn(manager, "second");
    const committed: ConversationHistorySnapshot = {
      version: 1,
      messages: [
        { role: "user", content: "first user" },
        { role: "assistant", content: "first assistant" },
        { role: "user", content: "second user" },
        { role: "assistant", content: "second assistant" },
      ],
      committedLeafId,
    };
    await state.historyStore.save(state.conversationId, committed, activeSignal());

    const stored = await state.historyStore.load(state.conversationId);
    const recovered = reopen(state, stored);

    expect(recovered.getLeafId()).toBe(committedLeafId);
    expect(context(recovered)).toContain("first assistant");
    expect(context(recovered)).toContain("second assistant");
  });

  test("missing snapshot resets an abandoned first turn to committed root", async () => {
    const state = await harness();
    const manager = SessionManager.open(
      state.sessionFile,
      state.sessionDirectory,
      state.workspaceDirectory,
    );
    appendTurn(manager, "abandoned first");

    const stored = await state.historyStore.load(state.conversationId);
    const recovered = reopen(state, stored);

    expect(stored).toEqual({ version: 1, messages: [], committedLeafId: null });
    expect(recovered.getLeafId()).toBeNull();
    expect(recovered.buildSessionContext().messages).toEqual([]);
  });

  test("leaves the standalone session path unchanged without recovery metadata", async () => {
    const state = await harness();
    const manager = SessionManager.open(
      state.sessionFile,
      state.sessionDirectory,
      state.workspaceDirectory,
    );
    const latestLeafId = appendTurn(manager, "standalone");

    const reopened = openSessionManagerForRecovery(
      state.sessionFile,
      state.sessionDirectory,
      state.workspaceDirectory,
    );

    expect(reopened.getLeafId()).toBe(latestLeafId);
    expect(context(reopened)).toContain("standalone assistant");
  });

  test("fails closed when snapshot messages do not match the committed branch", async () => {
    const state = await harness();
    const manager = SessionManager.open(
      state.sessionFile,
      state.sessionDirectory,
      state.workspaceDirectory,
    );
    appendTurn(manager, "first");
    const secondLeafId = appendTurn(manager, "second");

    expect(() => reopen(state, snapshot("first", secondLeafId))).toThrow(
      "Visible conversation history does not match committed Pi branch",
    );
  });

  test("fails closed for a missing session file and an unknown committed leaf", async () => {
    const missing = await harness();
    expect(() => reopen(missing, snapshot("missing", "missing-leaf"))).toThrow(
      "Committed visible history has no Pi session file",
    );

    const unknown = await harness();
    const manager = SessionManager.open(
      unknown.sessionFile,
      unknown.sessionDirectory,
      unknown.workspaceDirectory,
    );
    appendTurn(manager, "existing");
    expect(() => reopen(unknown, snapshot("unknown", "unknown-leaf"))).toThrow(
      "Committed Pi session leaf is unavailable",
    );
  });
});
