import { describe, expect, test } from "bun:test";
import {
  SessionTerminalError,
  streamSessionText,
  type SessionTextSource,
} from "../../src/session/session-text-stream.ts";

class FakeSource implements SessionTextSource {
  readonly #listeners = new Set<(event: unknown) => void>();
  readonly prompts: string[] = [];
  responses: string[] = [];
  events: unknown[] = [];
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
    for (const event of this.events) {
      for (const listener of this.#listeners) listener(event);
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

  test("fails on Pi assistant error and aborted terminal events", async () => {
    const updateError = new FakeSource();
    updateError.events = [{
      type: "message_update",
      assistantMessageEvent: {
        type: "error",
        reason: "error",
        error: { errorMessage: "fictional private provider detail" },
      },
    }];
    await expect(collect(streamSessionText(updateError, "prompt"))).rejects.toMatchObject({
      name: "SessionTerminalError",
      code: "assistant_error",
      message: "Pi assistant turn failed",
    });

    const messageEndAbort = new FakeSource();
    messageEndAbort.events = [{
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "aborted",
        errorMessage: "fictional private abort detail",
      },
    }];
    const failure = await collect(streamSessionText(messageEndAbort, "prompt")).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(SessionTerminalError);
    expect(failure).toMatchObject({
      code: "assistant_aborted",
      message: "Pi assistant turn aborted",
    });
    expect(String(failure)).not.toContain("private");
  });

  test("discards a failed attempt and publishes the successful auto-retry", async () => {
    const source = new FakeSource();
    source.events = [
      { type: "agent_start" },
      {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "discarded partial draft" },
      },
      {
        type: "message_update",
        assistantMessageEvent: { type: "error", reason: "error" },
      },
      {
        type: "message_end",
        message: { role: "assistant", stopReason: "error" },
      },
      { type: "agent_end", messages: [], willRetry: true },
      { type: "agent_start" },
      {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "recovered draft" },
      },
      {
        type: "message_end",
        message: { role: "assistant", stopReason: "stop" },
      },
      { type: "agent_end", messages: [], willRetry: false },
    ];

    expect(await collect(streamSessionText(source, "prompt"))).toEqual(["recovered draft"]);
    expect(source.abortCount).toBe(0);
  });

  test("fails length-limited and zero-visible-output turns", async () => {
    const lengthLimited = new FakeSource();
    lengthLimited.responses = ["partial draft"];
    lengthLimited.events = [{
      type: "message_end",
      message: { role: "assistant", stopReason: "length" },
    }];
    await expect(collect(streamSessionText(lengthLimited, "prompt"))).rejects.toMatchObject({
      name: "SessionTerminalError",
      code: "assistant_length",
      message: "Pi assistant turn reached its output limit",
    });

    for (const response of [[], [" \n\t"]]) {
      const empty = new FakeSource();
      empty.responses = response;
      await expect(collect(streamSessionText(empty, "prompt"))).rejects.toMatchObject({
        name: "SessionTerminalError",
        code: "assistant_empty",
        message: "Pi assistant turn produced no visible output",
      });
    }
  });

  test("aborts when the consumer stops before prompt completion", async () => {
    let releasePrompt = () => {};
    const source = new FakeSource();
    source.responses = ["first"];
    source.events = [{
      type: "message_end",
      message: { role: "assistant", stopReason: "stop" },
    }];
    source.promptGate = new Promise<void>((resolve) => { releasePrompt = resolve; });
    const iterator = streamSessionText(source, "prompt")[Symbol.asyncIterator]();

    expect(await iterator.next()).toEqual({ value: "first", done: false });
    await iterator.return?.();
    expect(source.abortCount).toBe(1);
    expect(source.unsubscribeCount).toBe(1);
    releasePrompt();
  });
});
