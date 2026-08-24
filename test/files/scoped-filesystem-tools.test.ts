import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { createScopedFilesystemTools } from "../../src/files/scoped-filesystem-tools.ts";

test("scopes private notes and conversation files without exposing host paths", async () => {
  const root = mkdtempSync(join(tmpdir(), "stein-scoped-files-"));
  const notes = join(root, "private-notes");
  const conversation = join(root, "private-conversation");
  const outside = join(root, "outside");
  mkdirSync(notes, { mode: 0o700 });
  mkdirSync(conversation, { mode: 0o700 });
  mkdirSync(outside, { mode: 0o700 });
  writeFileSync(join(notes, "guidance.md"), "domain-neutral guidance\n", { mode: 0o600 });
  writeFileSync(join(outside, "secret.md"), "outside\n", { mode: 0o600 });
  symlinkSync(join(outside, "secret.md"), join(conversation, "linked.md"));

  try {
    const tools = createScopedFilesystemTools(root, {
      readRoots: [
        { label: "notes", path: notes, virtualPath: "notes" },
        {
          label: "conversation",
          path: conversation,
          virtualPath: "conversation",
        },
      ],
      writeRoots: [{
        label: "conversation",
        path: conversation,
        virtualPath: "conversation",
      }],
      writeDenyGlobs: ["protected/**"],
    });

    expect(textContent(await execute(tools, "read", {
      path: "notes/guidance.md",
    }))).toContain("domain-neutral guidance");

    await execute(tools, "write", {
      path: "conversation/drafts/session-note.md",
      content: "initial draft\n",
    });
    await execute(tools, "edit", {
      path: "conversation/drafts/session-note.md",
      edits: [{ oldText: "initial", newText: "revised" }],
    });
    const drafts = join(conversation, "drafts");
    const draft = join(drafts, "session-note.md");
    expect(readFileSync(draft, "utf8")).toBe("revised draft\n");
    expect(statSync(drafts).mode & 0o777).toBe(0o700);
    expect(statSync(draft).mode & 0o777).toBe(0o600);

    const listed = textContent(await execute(tools, "ls", {
      path: "conversation/drafts",
    }));
    expect(listed).toContain("session-note.md");
    expect(textContent(await execute(tools, "read", {
      path: "conversation/drafts/session-note.md",
    }))).toContain("revised draft");

    const found = textContent(await execute(tools, "find", {
      pattern: "*.md",
      path: "notes",
    }));
    expect(found).toContain("notes/guidance.md");
    expect(found).not.toContain(root);

    await expect(execute(tools, "write", {
      path: "notes/changed.md",
      content: "denied\n",
    })).rejects.toThrow("Access denied");
    await expect(execute(tools, "write", {
      path: "conversation/protected/changed.md",
      content: "denied\n",
    })).rejects.toThrow("read-only");
    await expect(execute(tools, "grep", {
      pattern: "outside",
      path: outside,
    })).rejects.toThrow("Access denied");
    await expect(execute(tools, "read", {
      path: "conversation/../outside/secret.md",
    })).rejects.toThrow("Access denied");
    await expect(execute(tools, "read", {
      path: "conversation/linked.md",
    })).rejects.toThrow("Access denied");
    expect(existsSync(join(outside, "changed.md"))).toBe(false);

    try {
      await execute(tools, "read", { path: join(outside, "secret.md") });
      throw new Error("expected direct host path to be denied");
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain("<outside-allowed-roots>");
      expect(message).not.toContain(root);
      expect(message).not.toContain(outside);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

async function execute(
  tools: ToolDefinition<any, any, any>[],
  name: string,
  params: unknown,
): Promise<unknown> {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`missing tool: ${name}`);
  return tool.execute(
    "call_1",
    params,
    undefined,
    undefined,
    {} as ExtensionContext,
  );
}

function textContent(result: unknown): string {
  if (!result || typeof result !== "object" || !("content" in result)) return "";
  const content = (result as { content?: Array<{ text?: string }> }).content ?? [];
  return content.map((item) => item.text ?? "").join("\n");
}
