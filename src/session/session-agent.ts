import { type SessionTextSource, streamSessionText } from "./session-text-stream.ts";
import { type SessionTurn, serializeSessionTurn } from "./session-turn.ts";

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

export interface SessionTurnRollback {
  restore(): void;
}

export interface SessionTurnParticipant {
  beginTurn(): void;
  checkpoint(): SessionTurnRollback;
}

export type SessionCheckpoint = Readonly<{
  leafId: string | null;
  participantRollback: SessionTurnRollback | undefined;
}>;

export type SessionAgentOptions = Readonly<{
  conversationId: string;
  session: PiSession;
  turnParticipant?: SessionTurnParticipant;
  onDispose?: () => void;
}>;

export class SessionAgent {
  readonly conversationId: string;
  readonly #session: PiSession;
  readonly #turnParticipant: SessionTurnParticipant | undefined;
  readonly #onDispose: (() => void) | undefined;
  #active = false;
  #disposed = false;

  constructor(options: SessionAgentOptions) {
    if (!options.conversationId.trim()) throw new Error("conversationId must not be empty");
    this.conversationId = options.conversationId;
    this.#session = options.session;
    this.#turnParticipant = options.turnParticipant;
    this.#onDispose = options.onDispose;
  }

  async *respond(turn: SessionTurn): AsyncIterable<string> {
    if (this.#disposed) throw new Error("Session agent is disposed");
    if (this.#active) throw new Error("Session agent already has an active turn");
    const input = serializeSessionTurn(this.conversationId, turn);
    this.#turnParticipant?.beginTurn();
    const participantRollback = this.#turnParticipant?.checkpoint();
    this.#active = true;
    let completed = false;
    try {
      for await (const chunk of streamSessionText(this.#session, input)) yield chunk;
      completed = true;
    } catch (error) {
      completed = true;
      restoreParticipant(participantRollback, error);
    } finally {
      this.#active = false;
      if (!completed) participantRollback?.restore();
    }
  }

  checkpoint(): SessionCheckpoint {
    if (this.#disposed) throw new Error("Session agent is disposed");
    if (this.#active) throw new Error("Cannot checkpoint an active session turn");
    return {
      leafId: this.#session.sessionManager.getLeafId(),
      participantRollback: this.#turnParticipant?.checkpoint(),
    };
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
      if (checkpoint.leafId === null) this.#session.sessionManager.resetLeaf();
      else this.#session.sessionManager.branch(checkpoint.leafId);
      this.#session.sessionManager.appendCustomEntry("stein.turn_rollback", {
        checkpoint: checkpoint.leafId,
      });
      checkpoint.participantRollback?.restore();
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
    try {
      this.#onDispose?.();
    } finally {
      this.#session.dispose();
    }
  }
}

function restoreParticipant(
  rollback: SessionTurnRollback | undefined,
  turnFailure: unknown,
): never {
  try {
    rollback?.restore();
  } catch (rollbackFailure) {
    throw new AggregateError(
      [turnFailure, rollbackFailure],
      "Session turn failed and participant rollback also failed",
    );
  }
  throw turnFailure;
}
