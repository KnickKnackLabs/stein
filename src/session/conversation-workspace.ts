import { chmod, lstat, mkdir } from "node:fs/promises";
import { join } from "node:path";

const PRIVATE_DIRECTORY_MODE = 0o700;

export async function prepareConversationWorkspace(
  workspaceRoot: string,
  conversationId: string,
): Promise<string> {
  assertConversationId(conversationId);
  await ensurePrivateDirectory(workspaceRoot);
  const directory = join(workspaceRoot, conversationId);
  await ensurePrivateDirectory(directory);
  return directory;
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await assertDirectoryOrAbsent(path);
  await mkdir(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  await assertDirectoryOrAbsent(path);
  await chmod(path, PRIVATE_DIRECTORY_MODE);
}

async function assertDirectoryOrAbsent(path: string): Promise<void> {
  try {
    const status = await lstat(path);
    if (!status.isDirectory() || status.isSymbolicLink()) {
      throw new Error("Conversation workspace path must be a regular directory");
    }
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") return;
    throw error;
  }
}

function assertConversationId(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new Error("Conversation workspace requires a safe conversation identifier");
  }
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String(error.code)
    : undefined;
}
