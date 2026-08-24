import { describe, expect, test } from "bun:test";
import { handleServerRequest } from "../../src/server/server-runner.ts";

class RecordingService {
  readonly requests: Request[] = [];

  async fetch(request: Request): Promise<Response> {
    this.requests.push(request);
    return new Response("handled");
  }
}

describe("server request handling", () => {
  test("disables Bun timeout only for chat completion requests", async () => {
    const service = new RecordingService();
    const timeouts: Array<{ request: Request; seconds: number }> = [];
    const server = {
      timeout(request: Request, seconds: number) {
        timeouts.push({ request, seconds });
      },
    };
    const chat = new Request("http://localhost/v1/chat/completions?stream=true", {
      method: "POST",
    });
    const health = new Request("http://localhost/health");
    const wrongMethod = new Request("http://localhost/v1/chat/completions");

    expect(await (await handleServerRequest(service, chat, server)).text()).toBe("handled");
    await handleServerRequest(service, health, server);
    await handleServerRequest(service, wrongMethod, server);

    expect(service.requests).toEqual([chat, health, wrongMethod]);
    expect(timeouts).toEqual([{ request: chat, seconds: 0 }]);
  });
});
