import { streamSessionText, type SessionTextSource } from "./session-text-stream.ts";
import { serializeSessionTurn, type SessionTurn } from "./session-turn.ts";

export interface PiSession extends SessionTextSource {
  dispose(): void;
}

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

  async abort(): Promise<void> {
    await this.#session.abort?.();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#session.dispose();
  }
}
