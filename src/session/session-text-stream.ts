export interface SessionTextSource {
  subscribe(listener: (event: unknown) => void): () => void;
  prompt(input: string): Promise<void>;
  abort?(): Promise<void>;
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
  const unsubscribe = session.subscribe((event) => {
    const delta = textDelta(event);
    if (delta !== undefined) output.push(delta);
  });

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
      output.close();
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

function textDelta(event: unknown): string | undefined {
  if (!isRecord(event) || event.type !== "message_update") return undefined;
  const update = event.assistantMessageEvent;
  if (!isRecord(update) || update.type !== "text_delta") return undefined;
  return typeof update.delta === "string" ? update.delta : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
