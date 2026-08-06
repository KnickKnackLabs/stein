import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { SessionAgent, type PiSession } from "../../src/session/session-agent.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

type SessionMessage = Parameters<SessionManager["appendMessage"]>[0];

function appendTurn(manager: SessionManager, label: string): string {
  manager.appendMessage({
    role: "user",
    content: `${label} user`,
    timestamp: Date.now(),
  });
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

class SessionBackend implements PiSession {
  abortCount = 0;

  constructor(readonly sessionManager: SessionManager) {}
  subscribe(): () => void { return () => {}; }
  async prompt(): Promise<void> {}
  async abort(): Promise<void> { this.abortCount += 1; }
  dispose(): void {}
}

describe("persistent session rollback", () => {
  test("reopens on the checkpoint branch and excludes the abandoned turn from model context", async () => {
    const root = await mkdtemp(join(tmpdir(), "stein-session-rollback-"));
    roots.push(root);
    const sessionDirectory = join(root, "sessions");
    const workspaceDirectory = join(root, "workspace");
    await Promise.all([
      mkdir(sessionDirectory, { recursive: true }),
      mkdir(workspaceDirectory, { recursive: true }),
    ]);
    const sessionFile = join(sessionDirectory, "conversation.jsonl");
    const manager = SessionManager.open(sessionFile, sessionDirectory, workspaceDirectory);
    appendTurn(manager, "committed");
    const backend = new SessionBackend(manager);
    const agent = new SessionAgent({
      conversationId: "fictional-conversation",
      systemPrompt: "Fictional system prompt",
      model: { provider: "test", id: "deterministic" },
      storage: { sessionFile, sessionDirectory, workspaceDirectory },
      session: backend,
    });
    const checkpoint = agent.checkpoint();
    if (checkpoint === null) throw new Error("Expected a committed checkpoint");
    const abandonedId = appendTurn(manager, "abandoned");

    await agent.rollback(checkpoint);
    const rollbackId = manager.getLeafId();
    if (rollbackId === null) throw new Error("Expected a durable rollback marker");
    const reopened = SessionManager.open(sessionFile, sessionDirectory, workspaceDirectory);
    const activeIds = reopened.getBranch().map((entry) => entry.id);
    const context = JSON.stringify(reopened.buildSessionContext().messages);

    expect(backend.abortCount).toBe(1);
    expect(reopened.getLeafId()).toBe(rollbackId);
    expect(activeIds).toContain(checkpoint);
    expect(activeIds).toContain(rollbackId);
    expect(activeIds).not.toContain(abandonedId);
    expect(context).toContain("committed assistant");
    expect(context).not.toContain("abandoned assistant");
    expect(context).not.toContain("stein.turn_rollback");
  });
});
