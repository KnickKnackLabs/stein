import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileConversationHistoryStore } from "../../src/conversation/file-history-store.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("FileConversationHistoryStore", () => {
  test("atomically persists private visible history for a conversation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "stein-visible-history-"));
    temporaryDirectories.push(directory);
    const store = new FileConversationHistoryStore(directory);
    const conversationId = "a".repeat(64);
    const history = [
      { role: "user" as const, content: "fictional question" },
      { role: "assistant" as const, content: "fictional response" },
    ];

    expect(await store.load(conversationId)).toEqual([]);
    await store.save(conversationId, history);
    expect(await store.load(conversationId)).toEqual(history);

    const path = join(directory, `${conversationId}.visible-history.json`);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(history);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
  });
});
