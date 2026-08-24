import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readPrivateTextFile,
  readPrivateTextLines,
} from "../../src/files/private-text-file.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function privateFixture(content = "private input", mode = 0o600): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "stein-private-text-"));
  roots.push(root);
  const path = join(root, "input");
  await writeFile(path, content, { mode: 0o600 });
  await chmod(path, mode);
  return path;
}

describe("private text files", () => {
  test("reads an owner-only regular file", async () => {
    const path = await privateFixture();
    expect(await readPrivateTextFile(path, "Input file")).toBe("private input");
  });

  test("reads trimmed non-empty values one per line", async () => {
    const path = await privateFixture(" first-token \n\nsecond-token\r\n");
    expect(await readPrivateTextLines(path, "Token file")).toEqual([
      "first-token",
      "second-token",
    ]);
  });

  test("rejects group- or world-accessible input", async () => {
    const groupReadable = await privateFixture("private input", 0o640);
    const worldReadable = await privateFixture("private input", 0o604);

    await expect(readPrivateTextFile(groupReadable, "Input file"))
      .rejects.toThrow("group or other users");
    await expect(readPrivateTextFile(worldReadable, "Input file"))
      .rejects.toThrow("group or other users");
  });

  test("rejects directories and symbolic links", async () => {
    const root = await mkdtemp(join(tmpdir(), "stein-private-text-invalid-"));
    roots.push(root);
    const target = join(root, "target");
    const link = join(root, "link");
    await writeFile(target, "private input", { mode: 0o600 });
    await symlink(target, link);

    await expect(readPrivateTextFile(root, "Input file"))
      .rejects.toThrow("regular file");
    await expect(readPrivateTextFile(link, "Input file"))
      .rejects.toThrow("symbolic link");
  });
});
