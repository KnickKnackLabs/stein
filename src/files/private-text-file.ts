import { constants } from "node:fs";
import { open } from "node:fs/promises";

export async function readPrivateTextFile(path: string, label: string): Promise<string> {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (hasCode(error, "ELOOP")) {
      throw new Error(`${label} must not be a symbolic link`);
    }
    throw error;
  }

  try {
    const metadata = await file.stat();
    if (!metadata.isFile()) throw new Error(`${label} must be a regular file`);
    if ((metadata.mode & 0o077) !== 0) {
      throw new Error(`${label} must not be accessible by group or other users`);
    }
    return file.readFile("utf8");
  } finally {
    await file.close();
  }
}

export async function readPrivateTextLines(
  path: string,
  label: string,
): Promise<string[]> {
  return (await readPrivateTextFile(path, label))
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
