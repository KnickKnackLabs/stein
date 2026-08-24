import { constants } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  readdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { resolve } from "node:path";
import {
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  createScopedFilesystemAccess,
  type ScopedFilesystemPolicy,
} from "./scoped-filesystem-policy.ts";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

export function createScopedFilesystemTools(
  cwd: string,
  policy: ScopedFilesystemPolicy,
): ToolDefinition<any, any, any>[] {
  const resolvedCwd = resolve(cwd);
  const scoped = createScopedFilesystemAccess(resolvedCwd, policy);

  let readTool = createReadToolDefinition(resolvedCwd, {
    operations: {
      async access(path) {
        await access(
          await scoped.resolveRead(path, "read"),
          constants.R_OK,
        );
      },
      async readFile(path) {
        return readFile(await scoped.resolveRead(path, "read"));
      },
    },
  });
  readTool = withPromptGuideline(
    readTool,
    `This read tool is scoped to: ${scoped.readDescription}.`,
  );
  readTool = withRedactedErrors(readTool, scoped.redactReadError);

  let lsTool = createLsToolDefinition(resolvedCwd, {
    operations: {
      async exists(path) {
        return pathExists(await scoped.resolveRead(path, "list"));
      },
      async stat(path) {
        return stat(await scoped.resolveRead(path, "list"));
      },
      async readdir(path) {
        return readdir(await scoped.resolveRead(path, "list"));
      },
    },
  });
  lsTool = withPromptGuideline(
    lsTool,
    `This ls tool is scoped to: ${scoped.readDescription}. Paths returned inside a virtual root can be reused by prefixing that root, for example conversation/file.md.`,
  );
  lsTool = withRedactedErrors(lsTool, scoped.redactReadError);

  let grepTool = createGrepToolDefinition(resolvedCwd);
  grepTool = withTranslatedGrepPath(
    grepTool,
    (path) => scoped.resolveRead(path, "search"),
    resolvedCwd,
  );
  grepTool = withPromptGuideline(
    grepTool,
    `This grep tool is scoped to: ${scoped.readDescription}.`,
  );
  grepTool = withRedactedErrors(grepTool, scoped.redactReadError);

  let findTool = createFindToolDefinition(resolvedCwd, {
    operations: {
      async exists(path) {
        return pathExists(await scoped.resolveRead(path, "find"));
      },
      async glob(pattern, searchPath, options) {
        const searchRoot = await scoped.resolveSearch(searchPath, "find");
        const glob = new Bun.Glob(pattern);
        const results: string[] = [];
        for await (const path of glob.scan({
          absolute: true,
          cwd: searchRoot.hostPath,
          dot: true,
        })) {
          if (isIgnoredPath(path, options.ignore)) continue;
          results.push(await scoped.formatSearchResult(
            path,
            searchRoot,
            searchPath,
            "find",
          ));
          if (results.length >= options.limit) break;
        }
        return results;
      },
    },
  });
  findTool = withPromptGuideline(
    findTool,
    `This find tool is scoped to: ${scoped.readDescription}. Results use reusable virtual paths.`,
  );
  findTool = withRedactedErrors(findTool, scoped.redactReadError);

  let writeTool = createWriteToolDefinition(resolvedCwd, {
    operations: {
      async mkdir(path) {
        const hostPath = await scoped.resolveWrite(path, "write");
        await mkdir(hostPath, {
          mode: PRIVATE_DIRECTORY_MODE,
          recursive: true,
        });
        await chmod(hostPath, PRIVATE_DIRECTORY_MODE);
      },
      async writeFile(path, content) {
        const hostPath = await scoped.resolveWrite(path, "write");
        await writeFile(hostPath, content, {
          encoding: "utf8",
          mode: PRIVATE_FILE_MODE,
        });
        await chmod(hostPath, PRIVATE_FILE_MODE);
      },
    },
  });
  writeTool = withPromptGuideline(
    writeTool,
    `This write tool is restricted to: ${scoped.writeDescription}.`,
  );
  writeTool = withRedactedErrors(writeTool, scoped.redactWriteError);

  let editTool = createEditToolDefinition(resolvedCwd, {
    operations: {
      async access(path) {
        await access(
          await scoped.resolveWrite(path, "edit"),
          constants.R_OK | constants.W_OK,
        );
      },
      async readFile(path) {
        return readFile(await scoped.resolveWrite(path, "edit"));
      },
      async writeFile(path, content) {
        const hostPath = await scoped.resolveWrite(path, "edit");
        await writeFile(hostPath, content, "utf8");
        await chmod(hostPath, PRIVATE_FILE_MODE);
      },
    },
  });
  editTool = withPromptGuideline(
    editTool,
    `This edit tool is restricted to: ${scoped.writeDescription}.`,
  );
  editTool = withRedactedErrors(editTool, scoped.redactWriteError);

  return [readTool, grepTool, findTool, lsTool, writeTool, editTool];
}

function withPromptGuideline<T extends ToolDefinition<any, any, any>>(
  tool: T,
  guideline: string,
): T {
  return {
    ...tool,
    promptGuidelines: [...(tool.promptGuidelines ?? []), guideline],
  };
}

function withTranslatedGrepPath<T extends ToolDefinition<any, any, any>>(
  tool: T,
  resolveSearchPath: (path: string) => Promise<string>,
  cwd: string,
): T {
  const execute = tool.execute.bind(tool);
  return {
    ...tool,
    execute: async (toolCallId, args, signal, onUpdate, context) => {
      const grepArgs = args as { path?: string };
      const requestedPath = grepArgs.path || ".";
      const hostPath = await resolveSearchPath(resolve(cwd, requestedPath));
      return execute(
        toolCallId,
        { ...grepArgs, path: hostPath },
        signal,
        onUpdate,
        context,
      );
    },
  };
}

function withRedactedErrors<T extends ToolDefinition<any, any, any>>(
  tool: T,
  redact: (error: unknown) => Error,
): T {
  const execute = tool.execute.bind(tool);
  return {
    ...tool,
    execute: async (...args) => {
      try {
        return await execute(...args);
      } catch (error: unknown) {
        throw redact(error);
      }
    },
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

function isIgnoredPath(path: string, ignorePatterns: string[]): boolean {
  return ignorePatterns.some((pattern) => {
    if (pattern === "**/node_modules/**") return path.includes("/node_modules/");
    if (pattern === "**/.git/**") return path.includes("/.git/");
    return false;
  });
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String(error.code)
    : undefined;
}
