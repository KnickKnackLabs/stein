import { streamSessionText, type SessionTextSource } from "./session-text-stream.ts";
import { serializeSessionTurn, type SessionTurn } from "./session-turn.ts";

export interface PiSessionBranchManager {
  getLeafId(): string | null;
  branch(entryId: string): void;
  resetLeaf(): void;
  appendCustomEntry(customType: string, data?: unknown): string;
}

export interface PiSession extends SessionTextSource {
  readonly sessionManager: PiSessionBranchManager;
  dispose(): void;
}

export type SessionCheckpoint = string | null;

export type SessionAgentOptions = Readonly<{
  conversationId: string;
  session: PiSession;
}>;

export class SessionAgent {
  readonly conversationId: string;
  readonly #session: PiSession;
  #active = false;
  #disposed = false;

  constructor(options: SessionAgentOptions) {
    if (!options.conversationId.trim()) throw new Error("conversationId must not be empty");
    this.conversationId = options.conversationId;
    this.#session = options.session;
  }

  async *respond(turn: SessionTurn): AsyncIterable<string> {
    if (this.#disposed) throw new Error("Session agent is disposed");
    if (this.#active) throw new Error("Session agent already has an active turn");
    const input = serializeSessionTurn(this.conversationId, turn);
    this.#active = true;
    try {
      for await (const chunk of streamSessionText(this.#session, input)) yield chunk;
    } finally {
      this.#active = false;
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
        throw new AggregateError(
          [abortFailure, rollbackFailure],
          "Failed to abort and roll back Pi session turn",
        );
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
