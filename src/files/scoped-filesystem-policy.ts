import { constants } from "node:fs";
import { access, lstat, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export type ScopedRoot = Readonly<{
  label: string;
  path: string;
  virtualPath?: string;
}>;

export type ScopedFilesystemPolicy = Readonly<{
  readRoots: readonly ScopedRoot[];
  writeRoots: readonly ScopedRoot[];
  writeDenyGlobs?: readonly string[];
}>;

export type ScopedSearchRoot = Readonly<{
  hostPath: string;
  rootPath: string;
  virtualPath?: string;
}>;

export type ScopedFilesystemAccess = Readonly<{
  readDescription: string;
  writeDescription: string;
  resolveRead(path: string, action: string): Promise<string>;
  resolveWrite(path: string, action: string): Promise<string>;
  resolveSearch(path: string, action: string): Promise<ScopedSearchRoot>;
  formatSearchResult(
    hostPath: string,
    searchRoot: ScopedSearchRoot,
    requestedSearchPath: string,
    action: string,
  ): Promise<string>;
  redactReadError(error: unknown): Error;
  redactWriteError(error: unknown): Error;
}>;

type NormalizedRoot = Readonly<{
  label: string;
  path: string;
  virtualPath?: string;
  virtualResolvedPath?: string;
}>;

type ResolvedPath = Readonly<{
  hostPath: string;
  root: NormalizedRoot;
}>;

type WriteDenyGlob = Readonly<{
  pattern: string;
  matches(path: string): boolean;
}>;

/**
 * Restricts in-process tool path resolution. This is not an operating-system
 * sandbox and cannot eliminate races with concurrent filesystem mutation.
 */
export function createScopedFilesystemAccess(
  cwd: string,
  policy: ScopedFilesystemPolicy,
): ScopedFilesystemAccess {
  const resolvedCwd = resolve(cwd);
  const resolveRequestedPath = (path: string) => resolve(resolvedCwd, path);
  const readRoots = normalizeRoots(policy.readRoots, "readRoots", resolvedCwd);
  const writeRoots = normalizeRoots(policy.writeRoots, "writeRoots", resolvedCwd);
  validateConsistentVirtualRoots([...readRoots, ...writeRoots]);
  const writeDenyGlobs = compileWriteDenyGlobs(policy.writeDenyGlobs ?? []);

  return {
    readDescription: formatRoots(readRoots),
    writeDescription: formatRoots(writeRoots),
    async resolveRead(path, action) {
      return (await assertScopedPath(resolveRequestedPath(path), readRoots, action)).hostPath;
    },
    async resolveWrite(path, action) {
      return (
        await assertWritableScopedPath(
          resolveRequestedPath(path),
          writeRoots,
          action,
          writeDenyGlobs,
        )
      ).hostPath;
    },
    async resolveSearch(path, action) {
      const resolved = await assertScopedPath(resolveRequestedPath(path), readRoots, action);
      return {
        hostPath: resolved.hostPath,
        rootPath: resolved.root.path,
        ...(resolved.root.virtualPath ? { virtualPath: resolved.root.virtualPath } : {}),
      };
    },
    async formatSearchResult(hostPath, searchRoot, requestedSearchPath, action) {
      const root = readRoots.find(
        (candidate) =>
          candidate.path === searchRoot.rootPath &&
          candidate.virtualPath === searchRoot.virtualPath,
      );
      if (!root || !isWithinRoot(hostPath, root.path)) {
        throw outsideRootsError(action, "<find-result>", readRoots);
      }
      const validated = await validateHostPath(hostPath, root, action, "<find-result>", readRoots);
      if (!root.virtualPath) return validated.hostPath;
      const suffix = relative(root.path, validated.hostPath).replaceAll("\\", "/");
      const virtualResult = suffix ? `${root.virtualPath}/${suffix}` : root.virtualPath;
      // Pi's find tool relativizes results against its search path. Nesting the
      // virtual result beneath that path preserves the reusable virtual name.
      return join(requestedSearchPath, virtualResult);
    },
    redactReadError(error) {
      return virtualToolError(error, readRoots, resolvedCwd);
    },
    redactWriteError(error) {
      return virtualToolError(error, writeRoots, resolvedCwd);
    },
  };
}

function normalizeRoots(
  roots: readonly ScopedRoot[],
  field: string,
  cwd: string,
): NormalizedRoot[] {
  if (roots.length === 0) throw new Error(`${field} must not be empty`);
  const normalized = roots.map((root) => {
    if (!root.label.trim()) throw new Error(`${field} labels must not be empty`);
    if (!isAbsolute(root.path)) throw new Error(`${field} paths must be absolute`);
    const virtualPath = normalizeVirtualPath(root.virtualPath, field);
    return {
      label: root.label,
      path: resolve(root.path),
      ...(virtualPath ? { virtualPath, virtualResolvedPath: resolve(cwd, virtualPath) } : {}),
    };
  });
  const virtualPaths = normalized
    .map((root) => root.virtualPath)
    .filter((path): path is string => path !== undefined);
  if (new Set(virtualPaths).size !== virtualPaths.length) {
    throw new Error(`${field} virtualPath values must be unique`);
  }
  return normalized;
}

function normalizeVirtualPath(virtualPath: string | undefined, field: string): string | undefined {
  if (virtualPath === undefined) return undefined;
  const normalized = virtualPath.replaceAll("\\", "/").replace(/\/$/, "");
  if (!/^[a-z][a-z0-9-]*$/.test(normalized)) {
    throw new Error(`${field} virtualPath must be one lowercase top-level path segment`);
  }
  return normalized;
}

function validateConsistentVirtualRoots(roots: readonly NormalizedRoot[]): void {
  const byVirtualPath = new Map<string, string>();
  for (const root of roots) {
    if (!root.virtualPath) continue;
    const existing = byVirtualPath.get(root.virtualPath);
    if (existing && existing !== root.path) {
      throw new Error(
        `virtualPath ${JSON.stringify(root.virtualPath)} maps to conflicting host roots`,
      );
    }
    byVirtualPath.set(root.virtualPath, root.path);
  }
}

async function assertScopedPath(
  path: string,
  roots: readonly NormalizedRoot[],
  action: string,
): Promise<ResolvedPath> {
  const translated = translateScopedPath(path, roots);
  if (!translated) throw outsideRootsError(action, path, roots);
  return validateHostPath(translated.hostPath, translated.root, action, path, roots);
}

function translateScopedPath(
  path: string,
  roots: readonly NormalizedRoot[],
): ResolvedPath | undefined {
  const resolvedPath = resolve(path);
  for (const root of roots) {
    if (root.virtualResolvedPath) {
      if (!isWithinRoot(resolvedPath, root.virtualResolvedPath)) continue;
      const suffix = relative(root.virtualResolvedPath, resolvedPath);
      return { hostPath: resolve(root.path, suffix), root };
    }
    if (isWithinRoot(resolvedPath, root.path)) {
      return { hostPath: resolvedPath, root };
    }
  }
  return undefined;
}

async function validateHostPath(
  hostPath: string,
  root: NormalizedRoot,
  action: string,
  requestedPath: string,
  roots: readonly NormalizedRoot[],
): Promise<ResolvedPath> {
  await assertRootIsNotSymlink(root.path, action, requestedPath, roots);
  const realRoot = await realpathIfExists(root.path);
  const existingPath = await realpathIfExists(hostPath);
  if (existingPath) {
    if (!isWithinRoot(existingPath, realRoot ?? root.path)) {
      throw outsideRootsError(action, requestedPath, roots);
    }
    return { hostPath, root };
  }

  const existingParent = await nearestExistingAncestor(dirname(hostPath));
  if (existingParent) {
    const realParent = await realpath(existingParent);
    if (!isWithinRoot(realParent, realRoot ?? root.path)) {
      throw outsideRootsError(action, requestedPath, roots);
    }
  }
  return { hostPath, root };
}

async function assertWritableScopedPath(
  path: string,
  roots: readonly NormalizedRoot[],
  action: string,
  denyGlobs: readonly WriteDenyGlob[],
): Promise<ResolvedPath> {
  const scopedPath = await assertScopedPath(path, roots, action);
  await assertNotHardLinkedFile(scopedPath.hostPath, action, path, roots);
  const pathFromRoot = relative(scopedPath.root.path, scopedPath.hostPath).replaceAll("\\", "/");
  const deniedBy = denyGlobs.find((glob) => glob.matches(pathFromRoot));
  if (deniedBy) {
    throw protectedPathError(action, path, deniedBy.pattern, roots);
  }
  return scopedPath;
}

async function assertNotHardLinkedFile(
  hostPath: string,
  action: string,
  requestedPath: string,
  roots: readonly NormalizedRoot[],
): Promise<void> {
  try {
    const metadata = await stat(hostPath);
    if (metadata.isFile() && metadata.nlink > 1) {
      throw hardLinkedPathError(action, requestedPath, roots);
    }
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") return;
    throw error;
  }
}

function compileWriteDenyGlobs(patterns: readonly string[]): WriteDenyGlob[] {
  return patterns.map((pattern) => {
    const glob = new Bun.Glob(pattern);
    return { pattern, matches: (path) => glob.match(path) };
  });
}

async function assertRootIsNotSymlink(
  rootPath: string,
  action: string,
  path: string,
  roots: readonly NormalizedRoot[],
): Promise<void> {
  try {
    const rootStats = await lstat(rootPath);
    if (rootStats.isSymbolicLink()) {
      throw outsideRootsError(action, path, roots);
    }
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") return;
    throw error;
  }
}

async function nearestExistingAncestor(path: string): Promise<string | undefined> {
  let current = resolve(path);
  while (true) {
    try {
      await access(current, constants.F_OK);
      return current;
    } catch (error: unknown) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

async function realpathIfExists(path: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

function isWithinRoot(path: string, root: string): boolean {
  const child = resolve(path);
  const parent = resolve(root);
  const pathFromRoot = relative(parent, child);
  return pathFromRoot === "" || (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot));
}

function outsideRootsError(action: string, path: string, roots: readonly NormalizedRoot[]): Error {
  return new Error(
    `Access denied: cannot ${action} ${JSON.stringify(displayRequestedPath(path, roots))} outside allowed roots (${formatRoots(roots)}).`,
  );
}

function hardLinkedPathError(
  action: string,
  path: string,
  roots: readonly NormalizedRoot[],
): Error {
  return new Error(
    `Access denied: cannot ${action} ${JSON.stringify(displayRequestedPath(path, roots))} because files with multiple filesystem links are not safe write targets.`,
  );
}

function protectedPathError(
  action: string,
  path: string,
  pattern: string,
  roots: readonly NormalizedRoot[],
): Error {
  return new Error(
    `Access denied: cannot ${action} ${JSON.stringify(displayRequestedPath(path, roots))} because paths matching ${JSON.stringify(pattern)} are read-only.`,
  );
}

function displayRequestedPath(path: string, roots: readonly NormalizedRoot[]): string {
  const resolvedPath = resolve(path);
  for (const root of roots) {
    if (
      root.virtualPath &&
      root.virtualResolvedPath &&
      isWithinRoot(resolvedPath, root.virtualResolvedPath)
    ) {
      const suffix = relative(root.virtualResolvedPath, resolvedPath).replaceAll("\\", "/");
      return suffix ? `${root.virtualPath}/${suffix}` : root.virtualPath;
    }
    if (!root.virtualPath && isWithinRoot(resolvedPath, root.path)) return path;
  }
  return roots.some((root) => root.virtualPath) ? "<outside-allowed-roots>" : path;
}

function virtualToolError(error: unknown, roots: readonly NormalizedRoot[], cwd: string): Error {
  let message = error instanceof Error ? error.message : String(error);
  const replacements = roots
    .flatMap((root) => {
      if (!root.virtualPath) return [];
      return [
        [root.path, root.virtualPath],
        ...(root.virtualResolvedPath
          ? ([[root.virtualResolvedPath, root.virtualPath]] as const)
          : []),
      ] as const;
    })
    .sort(([left], [right]) => right.length - left.length);
  for (const [hostPath, virtualPath] of replacements) {
    message = message.replaceAll(hostPath, virtualPath);
  }
  message = message.replaceAll(cwd, "<workspace>");
  return new Error(message);
}

function formatRoots(roots: readonly NormalizedRoot[]): string {
  return roots
    .map((root) =>
      root.virtualPath ? `${root.label}: ${root.virtualPath}/` : `${root.label}: ${root.path}`,
    )
    .join("; ");
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
}
