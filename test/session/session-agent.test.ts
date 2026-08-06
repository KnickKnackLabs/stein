import { describe, expect, test } from "bun:test";
import { SessionAgent } from "../../src/session/session-agent.ts";
import type { SessionTurn } from "../../src/session/session-turn.ts";
import { FakePiSession } from "../support/fake-pi-session.ts";

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
    const session = new FakePiSession();
    session.responses = [["one ", "two"], ["three"]];
    const agent = new SessionAgent({ conversationId, session });

    expect(agent.conversationId).toBe(conversationId);
    expect(await collect(agent.respond(turn()))).toEqual(["one ", "two"]);
    expect(await collect(agent.respond(turn("Follow up.")))).toEqual(["three"]);
    expect(session.prompts).toHaveLength(2);
  });

  test("rejects overlapping turns and releases the guard afterward", async () => {
    let releasePrompt = () => {};
    const session = new FakePiSession();
    session.responses = [["first"]];
    session.promptGate = new Promise<void>((resolve) => { releasePrompt = resolve; });
    const agent = new SessionAgent({ conversationId, session });
    const first = agent.respond(turn())[Symbol.asyncIterator]();

    expect(await first.next()).toEqual({ value: "first", done: false });
    expect(collect(agent.respond(turn("Overlapping.")))).rejects.toThrow("active turn");
    expect(() => agent.checkpoint()).toThrow("active session turn");
    releasePrompt();
    expect(await first.next()).toEqual({ value: undefined, done: true });
    session.promptGate = undefined;
    expect(await collect(agent.respond(turn("Afterward.")))).toEqual([]);
  });

  test("checkpoints and rolls persistent session state back", async () => {
    const session = new FakePiSession();
    session.sessionManager.leafId = "committed-leaf";
    const agent = new SessionAgent({ conversationId, session });
    const checkpoint = agent.checkpoint();
    session.sessionManager.leafId = "abandoned-leaf";

    await agent.rollback(checkpoint);

    expect(session.abortCount).toBe(1);
    expect(session.sessionManager.branches).toEqual(["committed-leaf"]);
    expect(session.sessionManager.customEntries).toEqual([{
      type: "stein.turn_rollback",
      data: { checkpoint: "committed-leaf" },
    }]);
  });

  test("delegates abort and disposes once", async () => {
    const session = new FakePiSession();
    const agent = new SessionAgent({ conversationId, session });
    await agent.abort();
    agent.dispose();
    agent.dispose();
    expect(session.abortCount).toBe(1);
    expect(session.disposeCount).toBe(1);
    expect(collect(agent.respond(turn()))).rejects.toThrow("disposed");
    expect(() => agent.checkpoint()).toThrow("disposed");
  });
});
