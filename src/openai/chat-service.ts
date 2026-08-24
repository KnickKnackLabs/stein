import { timingSafeEqual } from "node:crypto";
import {
  ConversationConflictError,
  type ConversationHistoryStore,
} from "../conversation/conversation.ts";
import {
  ConversationRegistry,
  type ConversationAgentFactory,
} from "../conversation/conversation-registry.ts";
import type { AttachmentNormalizer } from "./attachment-normalizer.ts";
import {
  InvalidChatCompletionError,
  parseChatCompletion,
} from "./chat-completion.ts";
import { streamChatCompletion } from "./chat-stream.ts";
import type {
  RequestIdentity,
  RequestIdentityResolver,
} from "./request-identity.ts";

export type OpenAIChatServiceOptions = Readonly<{
  authorizedTokens: readonly string[];
  modelId: string;
  resolveIdentity: RequestIdentityResolver;
  normalizeAttachments?: AttachmentNormalizer;
  createAgent: ConversationAgentFactory;
  historyStore: ConversationHistoryStore;
}>;

export class OpenAIChatService {
  readonly #authorizedTokens: readonly string[];
  readonly #modelId: string;
  readonly #resolveIdentity: RequestIdentityResolver;
  readonly #normalizeAttachments: AttachmentNormalizer | undefined;
  readonly #registry: ConversationRegistry;

  constructor(options: OpenAIChatServiceOptions) {
    if (options.authorizedTokens.length === 0) {
      throw new Error("authorizedTokens must not be empty");
    }
    if (options.authorizedTokens.some((token) => !token.trim())) {
      throw new Error("authorizedTokens must not contain an empty value");
    }
    if (!options.modelId.trim()) throw new Error("modelId must not be empty");
    if (typeof options.resolveIdentity !== "function") {
      throw new Error("resolveIdentity must be a function");
    }
    if (
      options.normalizeAttachments !== undefined &&
      typeof options.normalizeAttachments !== "function"
    ) {
      throw new Error("normalizeAttachments must be a function");
    }
    this.#authorizedTokens = [...options.authorizedTokens];
    this.#modelId = options.modelId;
    this.#resolveIdentity = options.resolveIdentity;
    this.#normalizeAttachments = options.normalizeAttachments;
    this.#registry = new ConversationRegistry(options.createAgent, options.historyStore);
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method === "GET" && path === "/health") {
      return jsonResponse({ status: "ok" });
    }
    if (!authorized(request, this.#authorizedTokens)) {
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
    const identity = this.#resolveIdentity(request);
    if (!validIdentity(identity)) {
      return invalidResponse("Missing or invalid request identity");
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return invalidResponse("Request body must be valid JSON");
    }

    try {
      const messages = parseChatCompletion(
        body,
        this.#modelId,
        this.#normalizeAttachments,
      );
      const turn = await this.#registry.start(identity.userId, identity.chatId, messages);
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

function validIdentity(identity: RequestIdentity | undefined): identity is RequestIdentity {
  return Boolean(identity?.userId.trim() && identity.chatId.trim());
}

function authorized(request: Request, expected: readonly string[]): boolean {
  const value = request.headers.get("authorization");
  if (!value?.startsWith("Bearer ")) return false;
  const received = Buffer.from(value.slice("Bearer ".length));
  for (const candidate of expected) {
    const wanted = Buffer.from(candidate);
    if (received.length === wanted.length && timingSafeEqual(received, wanted)) {
      return true;
    }
  }
  return false;
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
