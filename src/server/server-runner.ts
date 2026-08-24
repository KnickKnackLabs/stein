import { chmod, mkdir } from "node:fs/promises";
import { FileConversationHistoryStore } from "../conversation/file-history-store.ts";
import { readPrivateTextFile, readPrivateTextLines } from "../files/private-text-file.ts";
import { OpenAIChatService } from "../openai/chat-service.ts";
import { openWebUiHeaderIdentityResolver } from "../openwebui/request-identity.ts";
import { createPiSessionFactory } from "../session/pi-session.ts";
import type { ServerConfig } from "./server-config.ts";

type ChatService = Pick<OpenAIChatService, "fetch">;
type ServerRequestControl = Readonly<{
  timeout(request: Request, seconds: number): void;
}>;

export function handleServerRequest(
  service: ChatService,
  request: Request,
  server: ServerRequestControl,
): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (request.method === "POST" && path === "/v1/chat/completions") {
    server.timeout(request, 0);
  }
  return service.fetch(request);
}

export async function runServer(config: ServerConfig): Promise<never> {
  await mkdir(config.sessionDirectory, { recursive: true, mode: 0o700 });
  await chmod(config.sessionDirectory, 0o700);
  const [authorizedTokens, systemPrompt] = await Promise.all([
    readPrivateTextLines(config.serviceTokenFile, "Service token file"),
    readPrivateTextFile(config.systemPromptFile, "System prompt file"),
  ]);
  if (authorizedTokens.length === 0) throw new Error("Service token file is empty");
  if (!systemPrompt.trim()) throw new Error("System prompt file is empty");

  const modelId = `${config.model.provider}/${config.model.id}`;
  const createSession = createPiSessionFactory({
    model: config.model,
    systemPrompt,
    workspaceDirectory: config.workspaceDirectory,
    sessionDirectory: config.sessionDirectory,
    agentDirectory: config.agentDirectory,
  });
  const service = new OpenAIChatService({
    authorizedTokens,
    modelId,
    resolveIdentity: openWebUiHeaderIdentityResolver,
    historyStore: new FileConversationHistoryStore(config.sessionDirectory),
    createAgent: ({ conversationId }, snapshot) =>
      createSession(conversationId, { committedLeafId: snapshot.committedLeafId }),
  });
  const server = Bun.serve({
    hostname: config.hostname,
    port: config.port,
    fetch: (request, requestServer) => handleServerRequest(service, request, requestServer),
  });
  process.stdout.write(`Stein session service listening on ${server.url.origin}\n`);
  return new Promise<never>(() => undefined);
}
