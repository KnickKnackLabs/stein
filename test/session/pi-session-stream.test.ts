import { describe, expect, test } from "bun:test";
import {
  PiSessionStream,
  type PiSessionBackend,
} from "../../src/session/pi-session-stream.ts";

class Deferred {
  readonly promise: Promise<void>;
  resolve!: () => void;

  constructor() {
    this.promise = new Promise((resolve) => {
      this.resolve = resolve;
    });
  }
}

class FakeSession implements PiSessionBackend {
  readonly prompts: string[] = [];
  readonly #listeners = new Set<(event: unknown) => void>();
  promptHandler: (input: string) => Promise<void> = async () => {};
  abortCount = 0;
  disposeCount = 0;
  unsubscribeCount = 0;

  subscribe(listener: (event: unknown) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
      this.unsubscribeCount += 1;
    };
  }

  prompt(input: string): Promise<void> {
    this.prompts.push(input);
    return this.promptHandler(input);
  }

  emit(event: unknown): void {
    for (const listener of this.#listeners) listener(event);
  }

  async abort(): Promise<void> {
    this.abortCount += 1;
  }

  dispose(): void {
    this.disposeCount += 1;
  }
}

async function collect(chunks: AsyncIterable<string>): Promise<string[]> {
  const output: string[] = [];
  for await (const chunk of chunks) output.push(chunk);
  return output;
}

function textDelta(delta: string): unknown {
  return {
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta },
  };
}

describe("PiSessionStream", () => {
  test("forwards the prompt and streams ordered text deltas", async () => {
    const session = new FakeSession();
    session.promptHandler = async () => {
      session.emit({ type: "message_update", assistantMessageEvent: { type: "thinking_delta" } });
      session.emit(textDelta("one "));
      session.emit(textDelta("two"));
    };
    const stream = new PiSessionStream(session);

    expect(await collect(stream.run("A fictional prompt"))).toEqual(["one ", "two"]);
    expect(session.prompts).toEqual(["A fictional prompt"]);
    expect(session.unsubscribeCount).toBe(1);
  });

  test("rejects empty prompts before touching the session", async () => {
    const session = new FakeSession();
    const stream = new PiSessionStream(session);

    await expect(collect(stream.run("  "))).rejects.toThrow("Prompt must not be empty");
    expect(session.prompts).toEqual([]);
  });

  test("prevents overlapping turns", async () => {
    const session = new FakeSession();
    const deferred = new Deferred();
    session.promptHandler = () => {
      session.emit(textDelta("started"));
      return deferred.promise;
    };
    const stream = new PiSessionStream(session);
    const first = stream.run("first")[Symbol.asyncIterator]();

    expect(await first.next()).toEqual({ value: "started", done: false });
    await expect(collect(stream.run("second"))).rejects.toThrow("already has an active turn");
    deferred.resolve();
    expect(await first.next()).toEqual({ value: undefined, done: true });
  });

  test("propagates failures and releases the active-turn guard", async () => {
    const session = new FakeSession();
    session.promptHandler = async () => {
      throw new Error("deterministic failure");
    };
    const stream = new PiSessionStream(session);

    await expect(collect(stream.run("first"))).rejects.toThrow("deterministic failure");
    session.promptHandler = async () => {};
    expect(await collect(stream.run("second"))).toEqual([]);
  });

  test("preserves undefined rejection values", async () => {
    const session = new FakeSession();
    session.promptHandler = () => Promise.reject(undefined);
    const stream = new PiSessionStream(session);
    let rejected = false;

    try {
      await collect(stream.run("prompt"));
    } catch (error) {
      rejected = true;
      expect(error).toBeUndefined();
    }
    expect(rejected).toBeTrue();
  });

  test("aborts when the consumer stops before prompt completion", async () => {
    const session = new FakeSession();
    const deferred = new Deferred();
    session.promptHandler = () => {
      session.emit(textDelta("first"));
      return deferred.promise;
    };
    const stream = new PiSessionStream(session);
    const iterator = stream.run("prompt")[Symbol.asyncIterator]();

    expect(await iterator.next()).toEqual({ value: "first", done: false });
    await iterator.return?.();
    expect(session.abortCount).toBe(1);
    expect(session.unsubscribeCount).toBe(1);
    deferred.resolve();
  });

  test("delegates explicit abort and disposes once", async () => {
    const session = new FakeSession();
    const stream = new PiSessionStream(session);

    await stream.abort();
    stream.dispose();
    stream.dispose();
    expect(session.abortCount).toBe(1);
    expect(session.disposeCount).toBe(1);
    await expect(collect(stream.run("after disposal"))).rejects.toThrow("disposed");
  });
});
