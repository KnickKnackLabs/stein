import { timingSafeEqual } from "node:crypto";
import {
  ConversationConflictError,
  type ConversationHistoryStore,
} from "../conversation/conversation.ts";
import {
  ConversationRegistry,
  type ConversationAgentFactory,
} from "../conversation/conversation-registry.ts";
import {
  InvalidChatCompletionError,
  parseChatCompletion,
} from "./chat-completion.ts";
import { streamChatCompletion } from "./chat-stream.ts";

export type OpenAIChatServiceOptions = Readonly<{
  bearerToken: string;
  modelId: string;
  createAgent: ConversationAgentFactory;
  historyStore: ConversationHistoryStore;
}>;

export class OpenAIChatService {
  readonly #bearerToken: string;
  readonly #modelId: string;
  readonly #registry: ConversationRegistry;

  constructor(options: OpenAIChatServiceOptions) {
    if (!options.bearerToken.trim()) throw new Error("bearerToken must not be empty");
    if (!options.modelId.trim()) throw new Error("modelId must not be empty");
    this.#bearerToken = options.bearerToken;
    this.#modelId = options.modelId;
    this.#registry = new ConversationRegistry(options.createAgent, options.historyStore);
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method === "GET" && path === "/health") {
      return jsonResponse({ status: "ok" });
    }
    if (!authorized(request, this.#bearerToken)) {
      return errorResponse("Unauthorized", "authentication_error", 401);
    }
    if (request.method === "GET" && path === "/v1/models") {
      return jsonResponse({
        object: "list",
        data: [{ id: this.#modelId, object: "model", owned_by: "stein" }],
      });
    }
    if (request.method === "POST" && path === "/v1/chat/completions") {
      return this.#chat(request);
    }
    return errorResponse("Not found", "not_found", 404);
  }

  async #chat(request: Request): Promise<Response> {
    const userId = request.headers.get("x-openwebui-user-id")?.trim();
    const chatId = request.headers.get("x-openwebui-chat-id")?.trim();
    if (!userId) return invalidResponse("Missing x-openwebui-user-id header");
    if (!chatId) return invalidResponse("Missing x-openwebui-chat-id header");

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return invalidResponse("Request body must be valid JSON");
    }

    try {
      const messages = parseChatCompletion(body, this.#modelId);
      const turn = await this.#registry.start(userId, chatId, messages);
      return streamChatCompletion(request, turn, this.#modelId);
    } catch (error) {
      if (error instanceof InvalidChatCompletionError) {
        return invalidResponse(error.message);
      }
      if (error instanceof ConversationConflictError) {
        return errorResponse(error.message, "conflict", 409);
      }
      throw error;
    }
  }
}

function authorized(request: Request, expected: string): boolean {
  const value = request.headers.get("authorization");
  if (!value?.startsWith("Bearer ")) return false;
  const received = Buffer.from(value.slice("Bearer ".length));
  const wanted = Buffer.from(expected);
  return received.length === wanted.length && timingSafeEqual(received, wanted);
}

function invalidResponse(message: string): Response {
  return errorResponse(message, "invalid_request_error", 400);
}

function errorResponse(message: string, type: string, status: number): Response {
  return jsonResponse({ error: { message, type } }, status);
}

function jsonResponse(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}
