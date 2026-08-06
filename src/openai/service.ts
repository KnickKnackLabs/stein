import { timingSafeEqual } from "node:crypto";
import {
  ConversationConflictError,
  ConversationRegistry,
  type AgentFactory,
  type ConversationHistoryStore,
  type ConversationTurn,
} from "../conversation/conversation-registry.ts";
import {
  errorResponse,
  InvalidChatRequestError,
  jsonResponse,
  parseChatCompletionRequest,
  sseChunk,
} from "./protocol.ts";

export type OpenAIChatServiceOptions = Readonly<{
  bearerToken: string;
  modelId: string;
  createAgent: AgentFactory;
  historyStore: ConversationHistoryStore;
}>;

export class OpenAIChatService {
  readonly #options: OpenAIChatServiceOptions;
  readonly #registry: ConversationRegistry;

  constructor(options: OpenAIChatServiceOptions) {
    if (!options.bearerToken) throw new Error("bearerToken must not be empty");
    if (!options.modelId) throw new Error("modelId must not be empty");
    this.#options = options;
    this.#registry = new ConversationRegistry(options.createAgent, options.historyStore);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return jsonResponse({ status: "ok" });
    }
    if (!authorized(request, this.#options.bearerToken)) {
      return errorResponse("Unauthorized", "authentication_error", 401);
    }
    if (request.method === "GET" && url.pathname === "/v1/models") {
      return jsonResponse({
        object: "list",
        data: [{ id: this.#options.modelId, object: "model", owned_by: "stein" }],
      });
    }
    if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
      return this.#chat(request);
    }
    return errorResponse("Not found", "not_found", 404);
  }

  async #chat(request: Request): Promise<Response> {
    const userId = requiredHeader(request, "x-openwebui-user-id");
    const chatId = requiredHeader(request, "x-openwebui-chat-id");
    if (!userId) return invalid("Missing x-openwebui-user-id header");
    if (!chatId) return invalid("Missing x-openwebui-chat-id header");

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return invalid("Request body must be valid JSON");
    }

    try {
      const messages = parseChatCompletionRequest(body, this.#options.modelId);
      const turn = await this.#registry.start(userId, chatId, messages);
      return this.#stream(request, turn);
    } catch (error) {
      if (error instanceof InvalidChatRequestError) return invalid(error.message);
      if (error instanceof ConversationConflictError) return errorResponse(error.message, "conflict", 409);
      throw error;
    }
  }

  #stream(request: Request, turn: ConversationTurn): Response {
    const encoder = new TextEncoder();
    const completionId = `chatcmpl-${turn.conversationId.slice(0, 24)}`;
    const created = Math.floor(Date.now() / 1000);
    let abortListener: (() => void) | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start: async (controller) => {
        if (request.signal.aborted) {
          await turn.abort();
          controller.error(new DOMException("Request aborted", "AbortError"));
          return;
        }
        abortListener = () => void turn.abort();
        request.signal.addEventListener("abort", abortListener, { once: true });
        try {
          controller.enqueue(encoder.encode(sseChunk(completionId, created, this.#options.modelId, { role: "assistant" }, null)));
          for await (const delta of turn.deltas) {
            controller.enqueue(encoder.encode(sseChunk(completionId, created, this.#options.modelId, { content: delta }, null)));
          }
          controller.enqueue(encoder.encode(sseChunk(completionId, created, this.#options.modelId, {}, "stop")));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        } catch (error) {
          controller.error(error);
        } finally {
          if (abortListener) request.signal.removeEventListener("abort", abortListener);
        }
      },
      cancel: () => turn.abort(),
    });
    return new Response(stream, {
      headers: {
        "cache-control": "no-cache",
        connection: "keep-alive",
        "content-type": "text/event-stream; charset=utf-8",
      },
    });
  }
}

function requiredHeader(request: Request, name: string): string | undefined {
  return request.headers.get(name)?.trim() || undefined;
}

function authorized(request: Request, expected: string): boolean {
  const actual = request.headers.get("authorization");
  if (!actual?.startsWith("Bearer ")) return false;
  const received = Buffer.from(actual.slice("Bearer ".length));
  const wanted = Buffer.from(expected);
  return received.length === wanted.length && timingSafeEqual(received, wanted);
}

function invalid(message: string): Response {
  return errorResponse(message, "invalid_request_error", 400);
}
