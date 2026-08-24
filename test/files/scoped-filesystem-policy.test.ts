import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createScopedFilesystemAccess } from "../../src/files/scoped-filesystem-policy.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
});

describe("scoped filesystem policy", () => {
  test("maps virtual reads and writes to their owned host roots", async () => {
    const fixture = await createFixture();
    const scoped = createScopedFilesystemAccess(fixture.root, {
      readRoots: [
        { label: "notes", path: fixture.notes, virtualPath: "notes" },
        {
          label: "conversation",
          path: fixture.conversation,
          virtualPath: "conversation",
        },
      ],
      writeRoots: [{
        label: "conversation",
        path: fixture.conversation,
        virtualPath: "conversation",
      }],
    });

    expect(await scoped.resolveRead(
      "notes/guidance.md",
      "read",
    )).toBe(join(fixture.notes, "guidance.md"));
    expect(await scoped.resolveWrite(
      "conversation/session-note.md",
      "write",
    )).toBe(join(fixture.conversation, "session-note.md"));
    await expect(scoped.resolveWrite(
      join(fixture.root, "notes/changed.md"),
      "write",
    )).rejects.toThrow("Access denied");
  });

  test("validates roots and enforces write deny globs", async () => {
    const fixture = await createFixture();
    expect(() => createScopedFilesystemAccess(fixture.root, {
      readRoots: [],
      writeRoots: [{ label: "conversation", path: fixture.conversation }],
    })).toThrow("readRoots must not be empty");
    expect(() => createScopedFilesystemAccess(fixture.root, {
      readRoots: [{ label: "notes", path: "relative-notes" }],
      writeRoots: [{ label: "conversation", path: fixture.conversation }],
    })).toThrow("readRoots paths must be absolute");
    expect(() => createScopedFilesystemAccess(fixture.root, {
      readRoots: [{ label: " ", path: fixture.notes }],
      writeRoots: [{ label: "conversation", path: fixture.conversation }],
    })).toThrow("readRoots labels must not be empty");
    expect(() => createScopedFilesystemAccess(fixture.root, {
      readRoots: [{
        label: "notes",
        path: fixture.notes,
        virtualPath: "shared",
      }],
      writeRoots: [{
        label: "conversation",
        path: fixture.conversation,
        virtualPath: "shared",
      }],
    })).toThrow("conflicting host roots");

    const scoped = createScopedFilesystemAccess(fixture.root, {
      readRoots: [{
        label: "conversation",
        path: fixture.conversation,
        virtualPath: "conversation",
      }],
      writeRoots: [{
        label: "conversation",
        path: fixture.conversation,
        virtualPath: "conversation",
      }],
      writeDenyGlobs: ["protected/**", "*.lock"],
    });
    expect(await scoped.resolveWrite("conversation/draft.md", "write"))
      .toBe(join(fixture.conversation, "draft.md"));
    for (const path of ["conversation/protected/file.md", "conversation/state.lock"]) {
      await expect(scoped.resolveWrite(path, "write"))
        .rejects.toThrow("read-only");
    }
  });

  test("rejects traversal and symlink escapes without exposing host paths", async () => {
    const fixture = await createFixture();
    const outsideFile = join(fixture.outside, "private.md");
    await writeFile(outsideFile, "outside\n", { mode: 0o600 });
    await symlink(outsideFile, join(fixture.conversation, "linked.md"));
    const scoped = createScopedFilesystemAccess(fixture.root, {
      readRoots: [{
        label: "conversation",
        path: fixture.conversation,
        virtualPath: "conversation",
      }],
      writeRoots: [{
        label: "conversation",
        path: fixture.conversation,
        virtualPath: "conversation",
      }],
    });

    for (const path of [
      join(fixture.root, "conversation/../outside/private.md"),
      join(fixture.root, "conversation/linked.md"),
      outsideFile,
    ]) {
      try {
        await scoped.resolveRead(path, "read");
        throw new Error("expected scoped read to fail");
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        expect(message).toContain("Access denied");
        expect(message).not.toContain(fixture.root);
        expect(message).not.toContain(fixture.outside);
      }
    }
  });
});

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "stein-scoped-policy-"));
  roots.push(root);
  const notes = join(root, "private-notes");
  const conversation = join(root, "private-conversation");
  const outside = join(root, "outside");
  await Promise.all([
    mkdir(notes, { mode: 0o700 }),
    mkdir(conversation, { mode: 0o700 }),
    mkdir(outside, { mode: 0o700 }),
  ]);
  await writeFile(join(notes, "guidance.md"), "guidance\n", { mode: 0o600 });
  return { root, notes, conversation, outside };
}
