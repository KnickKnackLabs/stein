import { describe, expect, test } from "bun:test";
import { SessionAgent, type SessionTurnParticipant } from "../../src/session/session-agent.ts";
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

class CounterTurnParticipant implements SessionTurnParticipant {
  value = 0;
  beginCount = 0;
  restoreCount = 0;

  beginTurn(): void {
    this.beginCount += 1;
    this.value = 0;
  }

  checkpoint() {
    const value = this.value;
    return {
      restore: () => {
        this.value = value;
        this.restoreCount += 1;
      },
    };
  }
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
    session.events = [
      {
        type: "message_end",
        message: { role: "assistant", stopReason: "stop" },
      },
    ];
    session.promptGate = new Promise<void>((resolve) => {
      releasePrompt = resolve;
    });
    const agent = new SessionAgent({ conversationId, session });
    const first = agent.respond(turn())[Symbol.asyncIterator]();

    expect(await first.next()).toEqual({ value: "first", done: false });
    expect(collect(agent.respond(turn("Overlapping.")))).rejects.toThrow("active turn");
    expect(() => agent.checkpoint()).toThrow("active session turn");
    releasePrompt();
    expect(await first.next()).toEqual({ value: undefined, done: true });
    session.promptGate = undefined;
    session.defaultResponse = ["afterward"];
    expect(await collect(agent.respond(turn("Afterward.")))).toEqual(["afterward"]);
  });

  test("checkpoints and rolls persistent session and participant state back", async () => {
    const participant = new CounterTurnParticipant();
    participant.value = 1;
    const session = new FakePiSession();
    session.sessionManager.leafId = "committed-leaf";
    const agent = new SessionAgent({
      conversationId,
      session,
      turnParticipant: participant,
    });
    const checkpoint = agent.checkpoint();
    participant.value = 2;
    session.sessionManager.leafId = "abandoned-leaf";

    await agent.rollback(checkpoint);

    expect(session.abortCount).toBe(1);
    expect(session.sessionManager.branches).toEqual(["committed-leaf"]);
    expect(session.sessionManager.customEntries).toEqual([
      {
        type: "stein.turn_rollback",
        data: { checkpoint: "committed-leaf" },
      },
    ]);
    expect(participant.value).toBe(1);
    expect(participant.restoreCount).toBe(1);
  });

  test("restores fresh participant state after a failed turn", async () => {
    const participant = new CounterTurnParticipant();
    participant.value = 7;
    const session = new FakePiSession();
    session.onPrompt = () => {
      participant.value = 2;
    };
    session.shouldFail = true;
    session.failure = new Error("fictional prompt failure");
    const agent = new SessionAgent({
      conversationId,
      session,
      turnParticipant: participant,
    });

    await expect(collect(agent.respond(turn()))).rejects.toThrow("fictional prompt failure");
    expect(participant.beginCount).toBe(1);
    expect(participant.value).toBe(0);
    expect(participant.restoreCount).toBe(1);
  });

  test("delegates abort and disposes resources and session once", async () => {
    const session = new FakePiSession();
    let resourceDisposeCount = 0;
    const agent = new SessionAgent({
      conversationId,
      session,
      onDispose: () => {
        resourceDisposeCount += 1;
      },
    });
    await agent.abort();
    agent.dispose();
    agent.dispose();
    expect(session.abortCount).toBe(1);
    expect(resourceDisposeCount).toBe(1);
    expect(session.disposeCount).toBe(1);
    expect(collect(agent.respond(turn()))).rejects.toThrow("disposed");
    expect(() => agent.checkpoint()).toThrow("disposed");
  });
});
