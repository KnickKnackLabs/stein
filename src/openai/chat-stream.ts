import { randomUUID } from "node:crypto";
import type { ConversationTurn } from "../conversation/conversation.ts";
import { chatCompletionChunk } from "./chat-completion.ts";

export function streamChatCompletion(
  request: Request,
  turn: ConversationTurn,
  modelId: string,
): Response {
  const encoder = new TextEncoder();
  const completionId = `chatcmpl-${randomUUID().replaceAll("-", "")}`;
  const created = Math.floor(Date.now() / 1000);
  let abortListener: (() => void) | undefined;
  let consumerCancelled = false;

  const stream = new ReadableStream<Uint8Array>({
    start: async (controller) => {
      if (request.signal.aborted) {
        try {
          await turn.abort();
          failStream(controller, new DOMException("Request aborted", "AbortError"));
        } catch (error) {
          failStream(controller, error);
        }
        return;
      }

      abortListener = () => {
        void turn.abort().then(
          () => failStream(controller, new DOMException("Request aborted", "AbortError")),
          (error: unknown) => failStream(controller, error),
        );
      };
      request.signal.addEventListener("abort", abortListener, { once: true });

      try {
        enqueue(
          controller,
          encoder,
          completionId,
          created,
          modelId,
          {
            role: "assistant",
          },
          null,
        );
        for await (const delta of turn.deltas) {
          enqueue(
            controller,
            encoder,
            completionId,
            created,
            modelId,
            {
              content: delta,
            },
            null,
          );
        }
        enqueue(controller, encoder, completionId, created, modelId, {}, "stop");
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (error) {
        if (!consumerCancelled) failStream(controller, error);
      } finally {
        if (abortListener) request.signal.removeEventListener("abort", abortListener);
      }
    },
    cancel: async () => {
      consumerCancelled = true;
      await turn.abort();
    },
  });

  return new Response(stream, {
    headers: {
      "cache-control": "no-cache",
      connection: "keep-alive",
      "content-type": "text/event-stream; charset=utf-8",
    },
  });
}

function enqueue(
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  id: string,
  created: number,
  modelId: string,
  delta: Readonly<Record<string, string>>,
  finishReason: "stop" | null,
): void {
  controller.enqueue(
    encoder.encode(chatCompletionChunk(id, created, modelId, delta, finishReason)),
  );
}

function failStream(controller: ReadableStreamDefaultController<Uint8Array>, error: unknown): void {
  try {
    controller.error(error);
  } catch {
    // Another stream path already closed or failed the response.
  }
}
