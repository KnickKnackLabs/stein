import { describe, expect, test } from "bun:test";
import {
  streamSessionText,
  type SessionTextSource,
} from "../../src/session/session-text-stream.ts";

class FakeSource implements SessionTextSource {
  readonly #listeners = new Set<(event: unknown) => void>();
  readonly prompts: string[] = [];
  responses: string[] = [];
  failure: unknown;
  shouldFail = false;
  synchronousFailure: unknown;
  promptGate: Promise<void> | undefined;
  abortCount = 0;
  unsubscribeCount = 0;

  subscribe(listener: (event: unknown) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
      this.unsubscribeCount += 1;
    };
  }

  prompt(input: string): Promise<void> {
    if (this.synchronousFailure !== undefined) throw this.synchronousFailure;
    this.prompts.push(input);
    for (const delta of this.responses) {
      for (const listener of this.#listeners) {
        listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta } });
      }
    }
    return this.#complete();
  }

  async #complete(): Promise<void> {
    await this.promptGate;
    if (this.shouldFail) throw this.failure;
  }

  async abort(): Promise<void> { this.abortCount += 1; }
}

async function collect(chunks: AsyncIterable<string>): Promise<string[]> {
  const output: string[] = [];
  for await (const chunk of chunks) output.push(chunk);
  return output;
}

describe("session text stream", () => {
  test("bridges ordered Pi text deltas into an async stream", async () => {
    const source = new FakeSource();
    source.responses = ["one ", "two"];
    expect(await collect(streamSessionText(source, "prompt"))).toEqual(["one ", "two"]);
    expect(source.prompts).toEqual(["prompt"]);
    expect(source.unsubscribeCount).toBe(1);
  });

  test("unsubscribes after synchronous and asynchronous prompt failures", async () => {
    const synchronous = new FakeSource();
    synchronous.synchronousFailure = new Error("synchronous failure");
    expect(collect(streamSessionText(synchronous, "prompt"))).rejects.toThrow("synchronous failure");
    expect(synchronous.unsubscribeCount).toBe(1);

    const asynchronous = new FakeSource();
    asynchronous.shouldFail = true;
    asynchronous.failure = new Error("asynchronous failure");
    expect(collect(streamSessionText(asynchronous, "prompt"))).rejects.toThrow("asynchronous failure");
    expect(asynchronous.unsubscribeCount).toBe(1);
  });

  test("preserves undefined rejection values", async () => {
    const source = new FakeSource();
    source.shouldFail = true;
    source.failure = undefined;
    expect(collect(streamSessionText(source, "prompt"))).rejects.toBeUndefined();
  });

  test("aborts when the consumer stops before prompt completion", async () => {
    let releasePrompt = () => {};
    const source = new FakeSource();
    source.responses = ["first"];
    source.promptGate = new Promise<void>((resolve) => { releasePrompt = resolve; });
    const iterator = streamSessionText(source, "prompt")[Symbol.asyncIterator]();

    expect(await iterator.next()).toEqual({ value: "first", done: false });
    await iterator.return?.();
    expect(source.abortCount).toBe(1);
    expect(source.unsubscribeCount).toBe(1);
    releasePrompt();
  });
});
