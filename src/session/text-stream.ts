export interface SessionTextSource {
  subscribe(listener: (event: unknown) => void): () => void;
  prompt(input: string): Promise<void>;
  abort?(): Promise<void>;
}

export type SessionTerminalFailure =
  | "assistant_error"
  | "assistant_aborted"
  | "assistant_length"
  | "assistant_empty";

const TERMINAL_FAILURE_MESSAGES: Readonly<Record<SessionTerminalFailure, string>> = {
  assistant_error: "Pi assistant turn failed",
  assistant_aborted: "Pi assistant turn aborted",
  assistant_length: "Pi assistant turn reached its output limit",
  assistant_empty: "Pi assistant turn produced no visible output",
};

export class SessionTerminalError extends Error {
  override readonly name = "SessionTerminalError";
  readonly code: SessionTerminalFailure;

  constructor(code: SessionTerminalFailure) {
    super(TERMINAL_FAILURE_MESSAGES[code]);
    this.code = code;
  }
}

type Waiter = {
  resolve(result: IteratorResult<string>): void;
  reject(error: unknown): void;
};

class AsyncTextQueue implements AsyncIterable<string> {
  readonly #values: string[] = [];
  readonly #waiters: Waiter[] = [];
  #closed = false;
  #failed = false;
  #failure: unknown;

  push(value: string): void {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter) waiter.resolve({ value, done: false });
    else this.#values.push(value);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#settle();
  }

  fail(error: unknown): void {
    if (this.#closed) return;
    this.#failed = true;
    this.#failure = error;
    this.#closed = true;
    this.#settle();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<string> {
    while (true) {
      const result = await this.#next();
      if (result.done) return;
      yield result.value;
    }
  }

  #next(): Promise<IteratorResult<string>> {
    const value = this.#values.shift();
    if (value !== undefined) return Promise.resolve({ value, done: false });
    if (this.#failed) return Promise.reject(this.#failure);
    if (this.#closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }));
  }

  #settle(): void {
    while (this.#waiters.length > 0) {
      const waiter = this.#waiters.shift();
      if (!waiter) return;
      if (this.#failed) waiter.reject(this.#failure);
      else waiter.resolve({ value: undefined, done: true });
    }
  }
}

export async function* streamSessionText(
  session: SessionTextSource,
  input: string,
): AsyncIterable<string> {
  const output = new AsyncTextQueue();
  const attempt = new AssistantAttemptBuffer();
  let hasVisibleText = false;
  const publish = (chunks: readonly string[]) => {
    for (const chunk of chunks) {
      hasVisibleText ||= /\S/u.test(chunk);
      output.push(chunk);
    }
  };
  const unsubscribe = session.subscribe((event) => publish(attempt.accept(event)));

  let completion: Promise<void>;
  try {
    completion = session.prompt(input);
  } catch (error) {
    unsubscribe();
    throw error;
  }
  let completionSettled = false;
  completion.then(
    () => {
      completionSettled = true;
      const result = attempt.finish();
      if (result.failure) output.fail(result.failure);
      else {
        publish(result.chunks);
        if (!hasVisibleText) output.fail(new SessionTerminalError("assistant_empty"));
        else output.close();
      }
    },
    (error: unknown) => {
      completionSettled = true;
      output.fail(error);
    },
  );

  try {
    for await (const chunk of output) yield chunk;
    await completion;
  } finally {
    unsubscribe();
    if (!completionSettled) await session.abort?.();
  }
}

type AttemptResult = Readonly<{
  chunks: readonly string[];
  failure?: SessionTerminalError;
}>;

class AssistantAttemptBuffer {
  #chunks: string[] = [];
  #failure: SessionTerminalError | undefined;
  #released = false;

  accept(event: unknown): readonly string[] {
    if (isRecord(event) && event.type === "agent_start") {
      this.#chunks = [];
      this.#failure = undefined;
      this.#released = false;
      return [];
    }

    const delta = textDelta(event);
    if (delta !== undefined) {
      this.#chunks.push(delta);
      return [];
    }

    const failure = terminalFailure(event);
    if (failure) {
      this.#failure = failure;
      return [];
    }

    if (isSuccessfulAssistantEnd(event)) return this.#release();
    return [];
  }

  finish(): AttemptResult {
    if (this.#failure) return { chunks: [], failure: this.#failure };
    return { chunks: this.#release() };
  }

  #release(): readonly string[] {
    if (this.#released) return [];
    this.#released = true;
    return this.#chunks.splice(0);
  }
}

function textDelta(event: unknown): string | undefined {
  if (!isRecord(event) || event.type !== "message_update") return undefined;
  const update = event.assistantMessageEvent;
  if (!isRecord(update) || update.type !== "text_delta") return undefined;
  return typeof update.delta === "string" ? update.delta : undefined;
}

function isSuccessfulAssistantEnd(event: unknown): boolean {
  if (!isRecord(event) || event.type !== "message_end") return false;
  const message = event.message;
  return isRecord(message) && message.role === "assistant" && message.stopReason === "stop";
}

function terminalFailure(event: unknown): SessionTerminalError | undefined {
  if (!isRecord(event)) return undefined;
  if (event.type === "message_update") {
    const update = event.assistantMessageEvent;
    if (!isRecord(update) || update.type !== "error") return undefined;
    return new SessionTerminalError(
      update.reason === "aborted" ? "assistant_aborted" : "assistant_error",
    );
  }
  if (event.type !== "message_end") return undefined;
  const message = event.message;
  if (!isRecord(message) || message.role !== "assistant") return undefined;
  if (message.stopReason === "length") {
    return new SessionTerminalError("assistant_length");
  }
  if (message.stopReason !== "error" && message.stopReason !== "aborted") return undefined;
  return new SessionTerminalError(
    message.stopReason === "aborted" ? "assistant_aborted" : "assistant_error",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
