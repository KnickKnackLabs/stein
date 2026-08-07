import { chmod, mkdir, readFile } from "node:fs/promises";
import { FileConversationHistoryStore } from "../conversation/file-history-store.ts";
import { OpenAIChatService } from "../openai/chat-service.ts";
import { createPiSessionFactory } from "../session/pi-session.ts";
import type { ServerConfig } from "./server-config.ts";

export async function runServer(config: ServerConfig): Promise<never> {
  await mkdir(config.sessionDirectory, { recursive: true, mode: 0o700 });
  await chmod(config.sessionDirectory, 0o700);
  const [bearerToken, systemPrompt] = await Promise.all([
    readFile(config.serviceTokenFile, "utf8"),
    readFile(config.systemPromptFile, "utf8"),
  ]);
  if (!bearerToken.trim()) throw new Error("Service token file is empty");
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
    bearerToken: bearerToken.trim(),
    modelId,
    historyStore: new FileConversationHistoryStore(config.sessionDirectory),
    createAgent: ({ conversationId }, snapshot) =>
      createSession(conversationId, {
        committedLeafId: snapshot.committedLeafId,
        committedMessageRoles: snapshot.messages.map(({ role }) => role),
      }),
  });
  const server = Bun.serve({
    hostname: config.hostname,
    port: config.port,
    fetch: (request) => service.fetch(request),
  });
  process.stdout.write(`Stein session service listening on ${server.url.origin}\n`);
  return new Promise<never>(() => undefined);
}
