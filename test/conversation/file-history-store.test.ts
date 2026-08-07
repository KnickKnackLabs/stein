import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ConversationHistorySnapshot,
  VisibleConversationMessage,
} from "../../src/conversation/conversation.ts";
import { FileConversationHistoryStore } from "../../src/conversation/file-history-store.ts";

const roots: string[] = [];
const activeSignal = (): AbortSignal => new AbortController().signal;

async function temporaryDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "stein-visible-history-"));
  roots.push(root);
  return root;
}

function snapshot(
  committedLeafId: string,
  messages: readonly VisibleConversationMessage[],
): ConversationHistorySnapshot {
  return { version: 1, messages, committedLeafId };
}

const firstMessages = [
  { role: "user" as const, content: "fictional question" },
  { role: "assistant" as const, content: "fictional response" },
];
const replacementMessages = [
  ...firstMessages,
  { role: "user" as const, content: "fictional follow-up" },
  { role: "assistant" as const, content: "fictional continuation" },
];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("FileConversationHistoryStore", () => {
  test("atomically replaces a versioned private history snapshot", async () => {
    const directory = join(await temporaryDirectory(), "history");
    const store = new FileConversationHistoryStore(directory);
    const conversationId = "a".repeat(64);
    const first = snapshot("first-leaf", firstMessages);
    const replacement = snapshot("replacement-leaf", replacementMessages);

    expect(await store.load(conversationId)).toEqual({
      version: 1,
      messages: [],
      committedLeafId: null,
    });
    await store.save(conversationId, first, activeSignal());
    await store.save(conversationId, replacement, activeSignal());

    const path = join(directory, `${conversationId}.visible-history.json`);
    expect(await store.load(conversationId)).toEqual(replacement);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(replacement);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readdir(directory)).toEqual([`${conversationId}.visible-history.json`]);
  });

  test("does not replace a committed snapshot after cancellation", async () => {
    const directory = join(await temporaryDirectory(), "history");
    const store = new FileConversationHistoryStore(directory);
    const conversationId = "b".repeat(64);
    const committed = snapshot("committed-leaf", firstMessages);
    await store.save(conversationId, committed, activeSignal());
    const controller = new AbortController();
    controller.abort();

    await expect(store.save(
      conversationId,
      snapshot("cancelled-leaf", replacementMessages),
      controller.signal,
    )).rejects.toHaveProperty("name", "AbortError");
    expect(await store.load(conversationId)).toEqual(committed);
    expect(await readdir(directory)).toEqual([`${conversationId}.visible-history.json`]);
  });

  test("rejects unsafe identities and malformed snapshot metadata", async () => {
    const directory = join(await temporaryDirectory(), "history");
    const store = new FileConversationHistoryStore(directory);
    await expect(store.load("../other-conversation")).rejects.toThrow("SHA-256");

    await mkdir(directory, { recursive: true });
    const conversationId = "b".repeat(64);
    const path = join(directory, `${conversationId}.visible-history.json`);
    await writeFile(path, JSON.stringify({
      version: 1,
      messages: [{ role: "system", content: "invalid" }],
      committedLeafId: "leaf",
    }));
    await expect(store.load(conversationId)).rejects.toThrow(
      "Invalid visible conversation history messages",
    );

    await writeFile(path, JSON.stringify({
      version: 1,
      messages: [],
      committedLeafId: "impossible-leaf",
    }));
    await expect(store.load(conversationId)).rejects.toThrow(
      "history and committed Pi leaf disagree",
    );

    await writeFile(path, JSON.stringify({
      version: 1,
      messages: firstMessages,
      committedLeafId: null,
    }));
    await expect(store.load(conversationId)).rejects.toThrow(
      "history and committed Pi leaf disagree",
    );

    await writeFile(path, JSON.stringify({
      version: 1,
      messages: [{ role: "assistant", content: "out of order" }],
      committedLeafId: "leaf",
    }));
    await expect(store.load(conversationId)).rejects.toThrow(
      "not a sequence of committed turns",
    );
  });

  test("rejects corrupt and legacy array-only history without guessing", async () => {
    const directory = join(await temporaryDirectory(), "history");
    const store = new FileConversationHistoryStore(directory);
    const conversationId = "d".repeat(64);
    const path = join(directory, `${conversationId}.visible-history.json`);
    await mkdir(directory, { recursive: true });

    await writeFile(path, "not-json");
    await expect(store.load(conversationId)).rejects.toThrow(
      "Invalid visible conversation history JSON",
    );

    await writeFile(path, JSON.stringify(firstMessages));
    await expect(store.load(conversationId)).rejects.toThrow(
      "Legacy array-only visible history requires an explicit migration or reset",
    );
  });

  test("cleans temporary output when atomic replacement fails", async () => {
    const directory = join(await temporaryDirectory(), "history");
    const conversationId = "c".repeat(64);
    await mkdir(join(directory, `${conversationId}.visible-history.json`), { recursive: true });
    const store = new FileConversationHistoryStore(directory);

    await expect(store.save(
      conversationId,
      snapshot("leaf", firstMessages),
      activeSignal(),
    )).rejects.toBeDefined();
    expect(await readdir(directory)).toEqual([`${conversationId}.visible-history.json`]);
  });

  test("requires an absolute history directory", () => {
    expect(() => new FileConversationHistoryStore("relative-history")).toThrow("absolute");
  });
});
