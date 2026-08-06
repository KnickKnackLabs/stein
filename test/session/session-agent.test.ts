import { describe, expect, test } from "bun:test";
import { SessionAgent, type PiSession } from "../../src/session/session-agent.ts";
import type { SessionTurn } from "../../src/session/session-turn.ts";

class FakeSession implements PiSession {
  readonly #listeners = new Set<(event: unknown) => void>();
  readonly prompts: string[] = [];
  responses: string[][] = [];
  promptGate: Promise<void> | undefined;
  abortCount = 0;
  disposeCount = 0;

  subscribe(listener: (event: unknown) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async prompt(input: string): Promise<void> {
    this.prompts.push(input);
    for (const delta of this.responses.shift() ?? []) {
      for (const listener of this.#listeners) {
        listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta } });
      }
    }
    await this.promptGate;
  }

  async abort(): Promise<void> { this.abortCount += 1; }
  dispose(): void { this.disposeCount += 1; }
}

const conversationId = "fictional-conversation";
function turn(userText = "A fictional user described a difficult transition."): SessionTurn {
  return { conversationId, userText, attachments: [] };
}
async function collect(chunks: AsyncIterable<string>): Promise<string[]> {
  const output: string[] = [];
  for await (const chunk of chunks) output.push(chunk);
  return output;
}

describe("SessionAgent", () => {
  test("reuses one identified session for sequential turns", async () => {
    const session = new FakeSession();
    session.responses = [["one ", "two"], ["three"]];
    const agent = new SessionAgent({ conversationId, session });

    expect(agent.conversationId).toBe(conversationId);
    expect(await collect(agent.respond(turn()))).toEqual(["one ", "two"]);
    expect(await collect(agent.respond(turn("Follow up.")))).toEqual(["three"]);
    expect(session.prompts).toHaveLength(2);
  });

  test("rejects overlapping turns and releases the guard afterward", async () => {
    let releasePrompt = () => {};
    const session = new FakeSession();
    session.responses = [["first"]];
    session.promptGate = new Promise<void>((resolve) => { releasePrompt = resolve; });
    const agent = new SessionAgent({ conversationId, session });
    const first = agent.respond(turn())[Symbol.asyncIterator]();

    expect(await first.next()).toEqual({ value: "first", done: false });
    expect(collect(agent.respond(turn("Overlapping.")))).rejects.toThrow("active turn");
    releasePrompt();
    expect(await first.next()).toEqual({ value: undefined, done: true });
    session.promptGate = undefined;
    expect(await collect(agent.respond(turn("Afterward.")))).toEqual([]);
  });

  test("delegates abort and disposes once", async () => {
    const session = new FakeSession();
    const agent = new SessionAgent({ conversationId, session });
    await agent.abort();
    agent.dispose();
    agent.dispose();
    expect(session.abortCount).toBe(1);
    expect(session.disposeCount).toBe(1);
    expect(collect(agent.respond(turn()))).rejects.toThrow("disposed");
  });
});
