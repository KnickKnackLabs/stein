import { describe, expect, test } from "bun:test";
import type {
  ConversationHistoryStore,
  ConversationIdentity,
  VisibleConversationMessage,
} from "../../src/conversation/conversation-registry.ts";
import { OpenAIChatService } from "../../src/openai/service.ts";
import {
  SessionAgent,
  type PiSession,
  type PiSessionManager,
} from "../../src/session/session-agent.ts";

class FakeSessionManager implements PiSessionManager {
  leafId: string | null = null;
  getLeafId(): string | null { return this.leafId; }
  branch(entryId: string): void { this.leafId = entryId; }
  resetLeaf(): void { this.leafId = null; }
  appendCustomEntry(): string { this.leafId = "rollback"; return this.leafId; }
}

class FakeSession implements PiSession {
  readonly sessionManager = new FakeSessionManager();
  readonly prompts: string[] = [];
  readonly #listeners = new Set<(event: unknown) => void>();
  chunks: string[] = ["hello", " world"];
  blocker: Promise<void> | undefined;
  disposed = 0;
  aborted = 0;

  subscribe(listener: (event: unknown) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  async prompt(input: string): Promise<void> {
    this.prompts.push(input);
    this.sessionManager.leafId = `turn-${this.prompts.length}`;
    if (this.blocker) await this.blocker;
    for (const delta of this.chunks) {
      for (const listener of this.#listeners) {
        listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta } });
      }
    }
  }
  async abort(): Promise<void> { this.aborted += 1; }
  dispose(): void { this.disposed += 1; }
}

class MemoryHistoryStore implements ConversationHistoryStore {
  readonly histories = new Map<string, readonly VisibleConversationMessage[]>();
  async load(conversationId: string): Promise<readonly VisibleConversationMessage[]> {
    return this.histories.get(conversationId) ?? [];
  }
  async save(conversationId: string, history: readonly VisibleConversationMessage[]): Promise<void> {
    this.histories.set(conversationId, structuredClone(history));
  }
}

function harness(configure?: (session: FakeSession, index: number) => void) {
  const identities: ConversationIdentity[] = [];
  const sessions: FakeSession[] = [];
  const service = new OpenAIChatService({
    historyStore: new MemoryHistoryStore(),
    bearerToken: "test-token",
    modelId: "test/deterministic",
    async createAgent(identity) {
      identities.push(identity);
      const session = new FakeSession();
      configure?.(session, sessions.length);
      sessions.push(session);
      return new SessionAgent({
        conversationId: identity.conversationId,
        systemPrompt: "Fictional prompt",
        model: { provider: "test", id: "deterministic" },
        storage: {
          sessionFile: `/tmp/${identity.conversationId}.jsonl`,
          sessionDirectory: "/tmp",
          workspaceDirectory: "/tmp/workspace",
        },
        session,
      });
    },
  });
  return { service, identities, sessions };
}

function request(path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  if (path !== "/health") headers.set("authorization", "Bearer test-token");
  return new Request(`http://localhost${path}`, { ...init, headers });
}
function chat(messages: unknown[], headers: Record<string, string> = {}): Request {
  return request("/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-openwebui-user-id": "fictional-user",
      "x-openwebui-chat-id": "fictional-chat",
      ...headers,
    },
    body: JSON.stringify({ model: "test/deterministic", stream: true, messages }),
  });
}
function user(content: string, attachments: unknown[] = []) {
  return { role: "user", content, attachments };
}
function dataEvents(body: string): unknown[] {
  return body
    .split("\n\n")
    .filter((event) => event.startsWith("data: ") && event !== "data: [DONE]")
    .map((event) => JSON.parse(event.slice("data: ".length)));
}

describe("OpenAIChatService", () => {
  test("exposes health without auth and protects model discovery", async () => {
    const { service } = harness();
    expect((await service.fetch(request("/health"))).status).toBe(200);
    const unauthorized = await service.fetch(new Request("http://localhost/v1/models"));
    expect(unauthorized.status).toBe(401);
    const models = await service.fetch(request("/v1/models"));
    expect(await models.json()).toEqual({
      object: "list",
      data: [{ id: "test/deterministic", object: "model", owned_by: "stein" }],
    });
  });

  test("requires explicit identity and streaming requests", async () => {
    const { service } = harness();
    const missingIdentity = await service.fetch(request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "test/deterministic", stream: true, messages: [user("hello")] }),
    }));
    expect(missingIdentity.status).toBe(400);
    const notStreaming = await service.fetch(request("/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-openwebui-user-id": "fictional-user",
        "x-openwebui-chat-id": "fictional-chat",
      },
      body: JSON.stringify({ model: "test/deterministic", stream: false, messages: [user("hello")] }),
    }));
    expect(notStreaming.status).toBe(400);
  });

  test("streams OpenAI chunks in order and forwards attached text", async () => {
    const { service, identities, sessions } = harness();
    const attachment = { name: "fictional.txt", text: "Already-present text" };
    const response = await service.fetch(chat([user("hello", [attachment])]));
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const body = await response.text();
    expect(body.endsWith("data: [DONE]\n\n")).toBe(true);
    const events = dataEvents(body) as Array<{ choices: Array<{ delta: { content?: string } }> }>;
    expect(events.map((event) => event.choices[0]?.delta.content).filter(Boolean)).toEqual(["hello", " world"]);
    expect(identities).toHaveLength(1);
    expect(JSON.parse(sessions[0]?.prompts[0] ?? "")).toEqual({
      conversationId: identities[0]?.conversationId,
      userText: "hello",
      attachments: [attachment],
    });
  });

  test("accepts an attachment-only request through the service boundary", async () => {
    const { service, sessions } = harness();
    const attachment = { name: "fictional.txt", text: "Already-present text" };
    const response = await service.fetch(chat([user("  ", [attachment])]));
    expect(response.status).toBe(200);
    await response.text();
    expect(JSON.parse(sessions[0]?.prompts[0] ?? "")).toEqual({
      conversationId: expect.any(String),
      userText: "  ",
      attachments: [attachment],
    });
  });

  test("cleans up a turn when the request was already aborted", async () => {
    const { service, sessions } = harness();
    const controller = new AbortController();
    controller.abort();
    const response = await service.fetch(new Request(chat([user("first")]), {
      signal: controller.signal,
    }));
    await response.text().catch(() => "aborted");
    await Bun.sleep(0);
    expect(sessions[0]?.aborted).toBe(1);
    expect(sessions[0]?.disposed).toBe(1);
  });

  test("aborts and disposes the session when the client disconnects", async () => {
    let release: (() => void) | undefined;
    const blocker = new Promise<void>((resolve) => { release = resolve; });
    const { service, sessions } = harness((session) => {
      session.blocker = blocker;
    });
    const controller = new AbortController();
    const pending = await service.fetch(new Request(chat([user("first")]), {
      signal: controller.signal,
    }));
    const body = pending.text().catch(() => "aborted");

    controller.abort();
    await Bun.sleep(0);
    expect(sessions[0]?.aborted).toBe(1);
    expect(sessions[0]?.disposed).toBe(1);

    release?.();
    await body;
  });
});
