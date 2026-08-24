import { afterEach, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareConversationWorkspace } from "../../src/session/conversation-workspace.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("conversation workspace", () => {
  test("creates isolated mode-0700 directories and repairs existing modes", async () => {
    const root = await createRoot();
    const workspaceRoot = join(root, "workspaces");
    await mkdir(workspaceRoot, { mode: 0o755 });

    const first = await prepareConversationWorkspace(workspaceRoot, "a".repeat(64));
    const second = await prepareConversationWorkspace(workspaceRoot, "b".repeat(64));
    await chmod(first, 0o755);
    expect(await prepareConversationWorkspace(workspaceRoot, "a".repeat(64))).toBe(first);

    expect(first).not.toBe(second);
    expect((await lstat(workspaceRoot)).mode & 0o777).toBe(0o700);
    expect((await lstat(first)).mode & 0o777).toBe(0o700);
    expect((await lstat(second)).mode & 0o777).toBe(0o700);
  });

  test("rejects unsafe identifiers and non-directory workspace paths", async () => {
    const root = await createRoot();
    await expect(prepareConversationWorkspace(root, "../escape")).rejects.toThrow(
      "safe conversation identifier",
    );

    const outside = await createRoot();
    const linkedRoot = join(root, "linked-root");
    await symlink(outside, linkedRoot);
    await expect(prepareConversationWorkspace(linkedRoot, "a".repeat(64))).rejects.toThrow(
      "regular directory",
    );

    const workspaceRoot = join(root, "workspaces");
    await mkdir(workspaceRoot);
    const linkedConversation = join(workspaceRoot, "b".repeat(64));
    await symlink(outside, linkedConversation);
    await expect(prepareConversationWorkspace(workspaceRoot, "b".repeat(64))).rejects.toThrow(
      "regular directory",
    );

    const fileConversation = join(workspaceRoot, "c".repeat(64));
    await writeFile(fileConversation, "not a workspace");
    await expect(prepareConversationWorkspace(workspaceRoot, "c".repeat(64))).rejects.toThrow(
      "regular directory",
    );
  });
});

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "stein-conversation-workspace-"));
  roots.push(root);
  return root;
}
