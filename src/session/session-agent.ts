import { isAbsolute } from "node:path";

export type ModelDescription = Readonly<{ provider: string; id: string }>;
export type SessionStorage = Readonly<{
  sessionFile: string;
  sessionDirectory: string;
  workspaceDirectory: string;
}>;
export type PiSessionSetup = Readonly<{
  conversationId: string;
  systemPrompt: string;
  model: ModelDescription;
  storage: SessionStorage;
}>;

export interface PiSessionManager {
  getLeafId(): string | null;
  branch(entryId: string): void;
  resetLeaf(): void;
  appendCustomEntry(customType: string, data?: unknown): string;
}

export interface PiSession {
  readonly sessionManager: PiSessionManager;
  subscribe(listener: (event: unknown) => void): () => void;
  prompt(input: string): Promise<void>;
  abort?(): Promise<void>;
  dispose(): void;
}

export type SessionCheckpoint = string | null;

export type SessionAttachment = Readonly<{ name: string; text: string }>;
export type SessionTurn = Readonly<{
  conversationId: string;
  userText: string;
  attachments: readonly SessionAttachment[];
}>;
export type SessionAgentOptions = PiSessionSetup & Readonly<{ session: PiSession }>;

type SerializedTurn = Readonly<{
  conversationId: string;
  userText: string;
  attachments: readonly SessionAttachment[];
}>;

class AsyncTextQueue implements AsyncIterable<string> {
  readonly #values: string[] = [];
  readonly #waiters: Array<{
    resolve: (result: IteratorResult<string>) => void;
    reject: (error: unknown) => void;
  }> = [];
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

export class SessionAgent {
  readonly setup: PiSessionSetup;
  readonly #session: PiSession;
  #active = false;
  #disposed = false;

  constructor(options: SessionAgentOptions) {
    this.setup = validateSetup(options);
    this.#session = options.session;
  }

  async *respond(turn: SessionTurn): AsyncIterable<string> {
    if (this.#disposed) throw new Error("Session agent is disposed");
    if (this.#active) throw new Error("Session agent already has an active turn");
    const input = serializeTurn(this.setup.conversationId, turn);
    this.#active = true;
    const output = new AsyncTextQueue();
    let unsubscribe: () => void;
    try {
      unsubscribe = this.#session.subscribe((event) => {
        const delta = textDelta(event);
        if (delta !== undefined) output.push(delta);
      });
    } catch (error) {
      this.#active = false;
      throw error;
    }

    let completion: Promise<void>;
    try {
      completion = this.#session.prompt(input);
    } catch (error) {
      unsubscribe();
      this.#active = false;
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
      try {
        if (!completionSettled) await this.#session.abort?.();
      } finally {
        this.#active = false;
      }
    }
  }

  checkpoint(): SessionCheckpoint {
    if (this.#disposed) throw new Error("Session agent is disposed");
    if (this.#active) throw new Error("Cannot checkpoint an active session turn");
    return this.#session.sessionManager.getLeafId();
  }

  async rollback(checkpoint: SessionCheckpoint): Promise<void> {
    if (this.#disposed) throw new Error("Session agent is disposed");

    let abortFailed = false;
    let abortFailure: unknown;
    try {
      await this.#session.abort?.();
    } catch (error) {
      abortFailed = true;
      abortFailure = error;
    }

    try {
      if (checkpoint === null) this.#session.sessionManager.resetLeaf();
      else this.#session.sessionManager.branch(checkpoint);
      this.#session.sessionManager.appendCustomEntry("stein.turn_rollback", { checkpoint });
    } catch (rollbackFailure) {
      if (abortFailed) {
        throw new AggregateError([abortFailure, rollbackFailure], "Failed to abort and roll back Pi session turn");
      }
      throw rollbackFailure;
    }

    if (abortFailed) throw abortFailure;
  }

  async abort(): Promise<void> {
    await this.#session.abort?.();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#session.dispose();
  }
}

function validateSetup(options: SessionAgentOptions): PiSessionSetup {
  requireText("conversationId", options.conversationId);
  requireText("systemPrompt", options.systemPrompt);
  requireText("model.provider", options.model.provider);
  requireText("model.id", options.model.id);
  requireAbsolutePath("storage.sessionFile", options.storage.sessionFile);
  requireAbsolutePath("storage.sessionDirectory", options.storage.sessionDirectory);
  requireAbsolutePath("storage.workspaceDirectory", options.storage.workspaceDirectory);
  return Object.freeze({
    conversationId: options.conversationId,
    systemPrompt: options.systemPrompt,
    model: Object.freeze({ ...options.model }),
    storage: Object.freeze({ ...options.storage }),
  });
}

function serializeTurn(expectedConversationId: string, turn: SessionTurn): string {
  if (turn.conversationId !== expectedConversationId) {
    throw new Error(`Conversation mismatch: expected ${JSON.stringify(expectedConversationId)}, received ${JSON.stringify(turn.conversationId)}`);
  }
  const attachments = turn.attachments.map((attachment, index) => {
    requireText(`attachments[${index}].name`, attachment.name);
    return { name: attachment.name, text: attachment.text };
  });
  if (!turn.userText.trim() && !attachments.some((attachment) => attachment.text.trim())) {
    throw new Error("Turn must contain user text or non-empty attached text");
  }
  const serialized: SerializedTurn = {
    conversationId: turn.conversationId,
    userText: turn.userText,
    attachments,
  };
  return JSON.stringify(serialized, null, 2);
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
function requireText(name: string, value: string): void {
  if (value.trim().length === 0) throw new Error(`${name} must not be empty`);
}
function requireAbsolutePath(name: string, value: string): void {
  requireText(name, value);
  if (!isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
}
