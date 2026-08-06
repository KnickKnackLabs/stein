import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileConversationHistoryStore } from "../../src/conversation/file-history-store.ts";

const roots: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "stein-visible-history-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("FileConversationHistoryStore", () => {
  test("atomically replaces private visible history", async () => {
    const directory = join(await temporaryDirectory(), "history");
    const store = new FileConversationHistoryStore(directory);
    const conversationId = "a".repeat(64);
    const first = [{ role: "user" as const, content: "fictional question" }];
    const replacement = [{ role: "assistant" as const, content: "fictional response" }];

    expect(await store.load(conversationId)).toEqual([]);
    await store.save(conversationId, first);
    await store.save(conversationId, replacement);

    const path = join(directory, `${conversationId}.visible-history.json`);
    expect(await store.load(conversationId)).toEqual(replacement);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(replacement);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readdir(directory)).toEqual([`${conversationId}.visible-history.json`]);
  });

  test("rejects unsafe identities and malformed persisted history", async () => {
    const directory = join(await temporaryDirectory(), "history");
    const store = new FileConversationHistoryStore(directory);
    await expect(store.load("../other-conversation")).rejects.toThrow("SHA-256");

    await mkdir(directory, { recursive: true });
    const conversationId = "b".repeat(64);
    await writeFile(
      join(directory, `${conversationId}.visible-history.json`),
      JSON.stringify([{ role: "system", content: "not visible history" }]),
    );
    await expect(store.load(conversationId)).rejects.toThrow("Invalid visible conversation history");
  });

  test("cleans temporary output when atomic replacement fails", async () => {
    const directory = join(await temporaryDirectory(), "history");
    const conversationId = "c".repeat(64);
    await mkdir(join(directory, `${conversationId}.visible-history.json`), { recursive: true });
    const store = new FileConversationHistoryStore(directory);

    await expect(store.save(conversationId, [{ role: "user", content: "question" }]))
      .rejects.toBeDefined();
    expect(await readdir(directory)).toEqual([`${conversationId}.visible-history.json`]);
  });

  test("requires an absolute history directory", () => {
    expect(() => new FileConversationHistoryStore("relative-history")).toThrow("absolute");
  });
});
