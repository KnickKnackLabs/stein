import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  SessionAgent,
  type PiSession,
  type PiSessionSetup,
  type SessionTurn,
} from "../../src/session/session-agent.ts";

class FakeSession implements PiSession {
  readonly prompts: string[] = [];
  readonly #listeners = new Set<(event: unknown) => void>();
  responses: string[][] = [];
  shouldFail = false;
  failure: unknown;
  subscribeFailure: unknown;
  promptGate: Promise<void> | undefined;
  abortCount = 0;
  disposeCount = 0;
  unsubscribeCount = 0;

  subscribe(listener: (event: unknown) => void): () => void {
    if (this.subscribeFailure !== undefined) throw this.subscribeFailure;
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
      this.unsubscribeCount += 1;
    };
  }
  async prompt(input: string): Promise<void> {
    this.prompts.push(input);
    for (const delta of this.responses.shift() ?? []) {
      for (const listener of this.#listeners) {
        listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta } });
      }
    }
    await this.promptGate;
    if (this.shouldFail) throw this.failure;
  }
  async abort(): Promise<void> { this.abortCount += 1; }
  dispose(): void { this.disposeCount += 1; }
}

const conversationId = "fictional-conversation";
function setup(overrides: Partial<PiSessionSetup> = {}): PiSessionSetup {
  return {
    conversationId,
    systemPrompt: "Fictional system prompt",
    model: { provider: "test", id: "deterministic" },
    storage: {
      sessionFile: join("/tmp", conversationId, "session.jsonl"),
      sessionDirectory: join("/tmp", conversationId),
      workspaceDirectory: join("/tmp", conversationId, "workspace"),
    },
    ...overrides,
  };
}
function turn(overrides: Partial<SessionTurn> = {}): SessionTurn {
  return {
    conversationId,
    userText: "A fictional user described a difficult transition.",
    attachments: [],
    ...overrides,
  };
}
async function collect(chunks: AsyncIterable<string>): Promise<string[]> {
  const output: string[] = [];
  for await (const chunk of chunks) output.push(chunk);
  return output;
}

describe("SessionAgent", () => {
  test("keeps explicit identity, prompt, model, and storage", () => {
    const expected = setup();
    const agent = new SessionAgent({ ...expected, session: new FakeSession() });
    expect(agent.setup).toEqual(expected);
  });

  test("rejects conversation mismatch before delegating", async () => {
    const session = new FakeSession();
    const agent = new SessionAgent({ ...setup(), session });
    expect(collect(agent.respond(turn({ conversationId: "other" })))).rejects.toThrow("Conversation mismatch");
    expect(session.prompts).toEqual([]);
  });

  test("forwards user and named attached text without file access", async () => {
    const session = new FakeSession();
    const agent = new SessionAgent({ ...setup(), session });
    const attachments = [{ name: "fictional-note.txt", text: "Already attached context." }];
    await collect(agent.respond(turn({ attachments })));
    expect(JSON.parse(session.prompts[0] ?? "")).toEqual({
      conversationId,
      userText: "A fictional user described a difficult transition.",
      attachments,
    });
  });

  test("accepts an attachment-only turn", async () => {
    const session = new FakeSession();
    const agent = new SessionAgent({ ...setup(), session });
    const attachments = [{ name: "fictional-note.txt", text: "Attached context without a message." }];
    await collect(agent.respond(turn({ userText: "  ", attachments })));
    expect(JSON.parse(session.prompts[0] ?? "")).toEqual({
      conversationId,
      userText: "  ",
      attachments,
    });
  });

  test("reuses one session and streams ordered text deltas", async () => {
    const session = new FakeSession();
    session.responses = [["one ", "two"], ["three"]];
    const agent = new SessionAgent({ ...setup(), session });
    expect(await collect(agent.respond(turn()))).toEqual(["one ", "two"]);
    expect(await collect(agent.respond(turn({ userText: "Follow up." })))).toEqual(["three"]);
    expect(session.prompts).toHaveLength(2);
    expect(session.unsubscribeCount).toBe(2);
  });

  test("releases the active-turn guard when subscription fails", async () => {
    const session = new FakeSession();
    session.subscribeFailure = new Error("subscription failure");
    const agent = new SessionAgent({ ...setup(), session });
    expect(collect(agent.respond(turn()))).rejects.toThrow("subscription failure");
    session.subscribeFailure = undefined;
    expect(await collect(agent.respond(turn()))).toEqual([]);
  });

  test("propagates failures and releases the active-turn guard", async () => {
    const session = new FakeSession();
    session.shouldFail = true;
    session.failure = new Error("deterministic failure");
    const agent = new SessionAgent({ ...setup(), session });
    expect(collect(agent.respond(turn()))).rejects.toThrow("deterministic failure");
    session.shouldFail = false;
    expect(await collect(agent.respond(turn()))).toEqual([]);
  });

  test("preserves undefined rejection values", async () => {
    const session = new FakeSession();
    session.shouldFail = true;
    session.failure = undefined;
    const agent = new SessionAgent({ ...setup(), session });
    expect(collect(agent.respond(turn()))).rejects.toBeUndefined();
  });

  test("aborts when the consumer stops before prompt completion", async () => {
    let releasePrompt = () => {};
    const session = new FakeSession();
    session.responses = [["first"]];
    session.promptGate = new Promise<void>((resolve) => { releasePrompt = resolve; });
    const agent = new SessionAgent({ ...setup(), session });
    const iterator = agent.respond(turn())[Symbol.asyncIterator]();

    expect(await iterator.next()).toEqual({ value: "first", done: false });
    await iterator.return?.();
    expect(session.abortCount).toBe(1);
    expect(session.unsubscribeCount).toBe(1);
    releasePrompt();
  });

  test("delegates abort and disposes once", async () => {
    const session = new FakeSession();
    const agent = new SessionAgent({ ...setup(), session });
    await agent.abort();
    agent.dispose();
    agent.dispose();
    expect(session.abortCount).toBe(1);
    expect(session.disposeCount).toBe(1);
  });
});
