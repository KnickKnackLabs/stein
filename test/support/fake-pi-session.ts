import type {
  PiSession,
  PiSessionBranchManager,
} from "../../src/session/session-agent.ts";

export class FakeSessionManager implements PiSessionBranchManager {
  leafId: string | null = null;
  readonly branches: Array<string | null> = [];
  readonly customEntries: Array<{ type: string; data: unknown }> = [];
  #nextId = 0;

  getLeafId(): string | null { return this.leafId; }
  branch(entryId: string): void { this.branches.push(entryId); this.leafId = entryId; }
  resetLeaf(): void { this.branches.push(null); this.leafId = null; }
  appendCustomEntry(type: string, data?: unknown): string {
    this.customEntries.push({ type, data });
    this.leafId = `session-${++this.#nextId}`;
    return this.leafId;
  }
  advance(): void { this.leafId = `session-${++this.#nextId}`; }
}

export class FakePiSession implements PiSession {
  readonly sessionManager = new FakeSessionManager();
  readonly #listeners = new Set<(event: unknown) => void>();
  readonly prompts: string[] = [];
  responses: string[][] = [];
  defaultResponse: string[] = [];
  events: unknown[] = [];
  failure: unknown;
  shouldFail = false;
  promptGate: Promise<void> | undefined;
  onPrompt: ((input: string) => void | Promise<void>) | undefined;
  releasePrompt: (() => void) | undefined;
  abortGate: Promise<void> | undefined;
  abortStarted: (() => void) | undefined;
  abortCount = 0;
  disposeCount = 0;

  subscribe(listener: (event: unknown) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async prompt(input: string): Promise<void> {
    this.prompts.push(input);
    this.sessionManager.advance();
    for (const delta of this.responses.shift() ?? this.defaultResponse) {
      for (const listener of this.#listeners) {
        listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta } });
      }
    }
    for (const event of this.events) {
      for (const listener of this.#listeners) listener(event);
    }
    await this.onPrompt?.(input);
    await this.promptGate;
    if (this.abortCount > 0) throw new Error("deterministic abort");
    if (this.shouldFail) throw this.failure;
  }

  async abort(): Promise<void> {
    this.abortCount += 1;
    this.releasePrompt?.();
    this.abortStarted?.();
    await this.abortGate;
  }

  dispose(): void { this.disposeCount += 1; }
}
