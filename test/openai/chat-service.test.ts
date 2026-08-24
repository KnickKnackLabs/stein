import { describe, expect, test } from "bun:test";
import {
  emptyConversationHistorySnapshot,
  type ConversationHistorySnapshot,
  type ConversationHistoryStore,
  type ConversationMessage,
} from "../../src/conversation/conversation.ts";
import type { ConversationIdentity } from "../../src/conversation/conversation-registry.ts";
import type { AttachmentNormalizer } from "../../src/openai/attachment-normalizer.ts";
import { OpenAIChatService } from "../../src/openai/chat-service.ts";
import type { RequestIdentityResolver } from "../../src/openai/request-identity.ts";
import { openWebUiHeaderIdentityResolver } from "../../src/openwebui/request-identity.ts";
import { SessionAgent } from "../../src/session/session-agent.ts";
import { FakePiSession } from "../support/fake-pi-session.ts";

class MemoryHistoryStore implements ConversationHistoryStore {
  readonly snapshots = new Map<string, ConversationHistorySnapshot>();

  async load(conversationId: string): Promise<ConversationHistorySnapshot> {
    return structuredClone(
      this.snapshots.get(conversationId) ?? emptyConversationHistorySnapshot(),
    );
  }

  async save(
    conversationId: string,
    snapshot: ConversationHistorySnapshot,
  ): Promise<void> {
    this.snapshots.set(conversationId, structuredClone(snapshot));
  }
}

function harness(
  configure?: (session: FakePiSession, index: number) => void,
  authorizedTokens: readonly string[] = ["test-token"],
  resolveIdentity: RequestIdentityResolver = openWebUiHeaderIdentityResolver,
  normalizeAttachments?: AttachmentNormalizer,
) {
  const identities: ConversationIdentity[] = [];
  const sessions: FakePiSession[] = [];
  const historyStore = new MemoryHistoryStore();
  const service = new OpenAIChatService({
    historyStore,
    authorizedTokens,
    modelId: "test/deterministic",
    resolveIdentity,
    ...(normalizeAttachments ? { normalizeAttachments } : {}),
    async createAgent(identity) {
      identities.push(identity);
      const session = new FakePiSession();
      session.defaultResponse = ["hello", " world"];
      configure?.(session, sessions.length);
      sessions.push(session);
      return new SessionAgent({ conversationId: identity.conversationId, session });
    },
  });
  return { service, identities, sessions, historyStore };
}

function request(path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  if (path !== "/health") headers.set("authorization", "Bearer test-token");
  return new Request(`http://localhost${path}`, { ...init, headers });
}

function chat(
  messages: readonly unknown[],
  headers: Readonly<Record<string, string>> = {},
): Request {
  return request("/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-openwebui-user-id": "fictional-user",
      "x-openwebui-chat-id": "fictional-chat",
      ...headers,
    },
    body: JSON.stringify({
      model: "test/deterministic",
      stream: true,
      messages,
    }),
  });
}

function user(
  content: string,
  attachments: ConversationMessage["attachments"] = [],
): ConversationMessage {
  return { role: "user", content, attachments };
}

function assistant(content: string): Readonly<{ role: "assistant"; content: string }> {
  return { role: "assistant", content };
}

function dataEvents(body: string): Array<Record<string, unknown>> {
  return body
    .split("\n\n")
    .filter((event) => event.startsWith("data: ") && event !== "data: [DONE]")
    .map((event) => JSON.parse(event.slice("data: ".length)) as Record<string, unknown>);
}

describe("OpenAIChatService", () => {
  test("accepts any value from a multi-token authorized set", async () => {
    const { service } = harness(undefined, ["test-token", "second-token"]);
    const accepted = await service.fetch(new Request("http://localhost/v1/models", {
      headers: { authorization: "Bearer second-token" },
    }));
    expect(accepted.status).toBe(200);

    const rejected = await service.fetch(new Request("http://localhost/v1/models", {
      headers: { authorization: "Bearer unknown-token" },
    }));
    expect(rejected.status).toBe(401);
  });

  test("rejects an empty authorized-token set or value", () => {
    expect(() => harness(undefined, [])).toThrow("authorizedTokens must not be empty");
    expect(() => harness(undefined, ["test-token", " "])).toThrow(
      "authorizedTokens must not contain an empty value",
    );
  });

  test("uses an injected request identity and rejects blank resolver output", async () => {
    let resolvedPath = "";
    const resolveIdentity: RequestIdentityResolver = (identityRequest) => {
      resolvedPath = new URL(identityRequest.url).pathname;
      return { userId: "resolved-user", chatId: "resolved-chat" };
    };
    const { service, identities } = harness(undefined, ["test-token"], resolveIdentity);
    const response = await service.fetch(request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "test/deterministic",
        stream: true,
        messages: [user("hello")],
      }),
    }));
    await response.text();

    expect(resolvedPath).toBe("/v1/chat/completions");
    expect(identities[0]).toMatchObject({
      userId: "resolved-user",
      chatId: "resolved-chat",
    });

    const { service: blankIdentity } = harness(
      undefined,
      ["test-token"],
      () => ({ userId: " ", chatId: "resolved-chat" }),
    );
    expect((await blankIdentity.fetch(chat([user("hello")]))).status).toBe(400);
  });

  test("exposes health and protects every model endpoint", async () => {
    const { service } = harness();
    expect((await service.fetch(request("/health"))).status).toBe(200);

    const unauthorized = await service.fetch(
      new Request("http://localhost/v1/models"),
    );
    expect(unauthorized.status).toBe(401);

    const wrongToken = await service.fetch(new Request("http://localhost/v1/models", {
      headers: { authorization: "Bearer wrong-token" },
    }));
    expect(wrongToken.status).toBe(401);

    const models = await service.fetch(request("/v1/models"));
    expect(await models.json()).toEqual({
      object: "list",
      data: [{ id: "test/deterministic", object: "model", owned_by: "stein" }],
    });
  });

  test("requires explicit Open WebUI identity and valid JSON", async () => {
    const { service } = harness();
    const missingIdentity = await service.fetch(request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "test/deterministic",
        stream: true,
        messages: [user("hello")],
      }),
    }));
    expect(missingIdentity.status).toBe(400);

    const invalidJson = await service.fetch(request("/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-openwebui-user-id": "fictional-user",
        "x-openwebui-chat-id": "fictional-chat",
      },
      body: "not-json",
    }));
    expect(invalidJson.status).toBe(400);
  });

  test("streams ordered chunks and forwards attached text", async () => {
    const { service, identities, sessions } = harness();
    const attachment = { name: "fictional.txt", text: "Already-present text" };
    const response = await service.fetch(chat([user("hello", [attachment])]));

    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const body = await response.text();
    expect(body.endsWith("data: [DONE]\n\n")).toBe(true);
    const events = dataEvents(body) as Array<{
      choices: Array<{ delta: { content?: string } }>;
    }>;
    expect(events
      .map((event) => event.choices[0]?.delta.content)
      .filter(Boolean)).toEqual(["hello", " world"]);
    expect(identities).toHaveLength(1);
    expect(JSON.parse(sessions[0]?.prompts[0] ?? "")).toEqual({
      userText: "hello",
      attachments: [attachment],
    });
  });

  test("applies an injected attachment normalizer before opening the turn", async () => {
    const normalizeAttachments: AttachmentNormalizer = ({ content, attachments }) => ({
      content: content.replace("[embedded]", "").trim(),
      attachments: [
        { name: "normalized.txt", text: "Normalized text." },
        ...attachments,
      ],
    });
    const { service, sessions } = harness(
      undefined,
      ["test-token"],
      openWebUiHeaderIdentityResolver,
      normalizeAttachments,
    );
    const response = await service.fetch(chat([user("Continue [embedded]", [
      { name: "structured.txt", text: "Structured text." },
    ])]));

    expect(response.status).toBe(200);
    await response.text();
    expect(JSON.parse(sessions[0]?.prompts[0] ?? "")).toEqual({
      userText: "Continue",
      attachments: [
        { name: "normalized.txt", text: "Normalized text." },
        { name: "structured.txt", text: "Structured text." },
      ],
    });
  });

  test("accepts an attachment-only user turn", async () => {
    const { service, sessions } = harness();
    const attachment = { name: "fictional.txt", text: "Already-present text" };
    const response = await service.fetch(chat([user("  ", [attachment])]));

    expect(response.status).toBe(200);
    await response.text();
    expect(JSON.parse(sessions[0]?.prompts[0] ?? "")).toEqual({
      userText: "  ",
      attachments: [attachment],
    });
  });

  test("maps an overlapping conversation turn to conflict", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { service } = harness((session) => {
      session.defaultResponse = ["first response"];
      session.promptGate = gate;
    });
    const first = await service.fetch(chat([user("first")]));
    await Promise.resolve();

    const overlap = await service.fetch(chat([user("overlap")]));
    expect(overlap.status).toBe(409);
    release();
    await first.text();
  });

  test("maps a divergent visible history to conflict", async () => {
    const { service } = harness();
    const first = await service.fetch(chat([user("first")]));
    await first.text();

    const divergent = await service.fetch(chat([
      user("different"),
      assistant("hello world"),
      user("second"),
    ]));
    expect(divergent.status).toBe(409);
  });

  test("rolls back a turn when the request was already aborted", async () => {
    const { service, sessions } = harness();
    const controller = new AbortController();
    controller.abort();
    const response = await service.fetch(new Request(chat([user("first")]), {
      signal: controller.signal,
    }));

    await response.text().catch(() => "aborted");
    await Bun.sleep(0);
    expect(sessions[0]?.abortCount).toBe(1);
    expect(sessions[0]?.disposeCount).toBe(1);
  });

  test("rolls back when the active request is aborted", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { service, sessions } = harness((session) => {
      session.defaultResponse = [];
      session.promptGate = gate;
      session.releasePrompt = release;
    });
    const controller = new AbortController();
    const response = await service.fetch(new Request(chat([user("first")]), {
      signal: controller.signal,
    }));
    const body = response.text().catch(() => "aborted");

    controller.abort();
    await body;
    expect(sessions[0]?.abortCount).toBeGreaterThanOrEqual(1);
    expect(sessions[0]?.disposeCount).toBe(1);
  });

  test("rolls back when the response reader cancels", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { service, sessions } = harness((session) => {
      session.defaultResponse = [];
      session.promptGate = gate;
      session.releasePrompt = release;
    });
    const response = await service.fetch(chat([user("first")]));
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();

    await reader?.read();
    await reader?.cancel();
    expect(sessions[0]?.abortCount).toBeGreaterThanOrEqual(1);
    expect(sessions[0]?.disposeCount).toBe(1);
  });
});
