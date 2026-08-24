import { isAbsolute, posix, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";

const DEFAULT_RUNNING_THRESHOLD_MS = 1_000;

export type SessionActivityRoot = Readonly<{
  virtualPath: string;
  directory: string;
}>;

export type SessionActivityTarget =
  | Readonly<{ kind: "virtual"; path: string }>
  | Readonly<{ kind: "redacted" }>;

export type SessionActivityEvent =
  | Readonly<{
      type: "tool";
      toolName: string;
      target?: SessionActivityTarget;
      status: "running";
    }>
  | Readonly<{
      type: "tool";
      toolName: string;
      target?: SessionActivityTarget;
      status: "ok" | "error";
      durationMs?: number;
    }>;

export type SessionActivityOptions = Readonly<{
  roots: readonly SessionActivityRoot[];
  sink(event: SessionActivityEvent): void;
  runningThresholdMs?: number;
}>;

export type SessionActivityRuntime = Readonly<{
  now?: () => number;
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancel?: (handle: unknown) => void;
}>;

type SessionActivitySource = Readonly<{
  subscribe(listener: (event: unknown) => void): () => void;
}>;

type NormalizedRoot = Readonly<{
  virtualPath: string;
  directory: string;
}>;

type PendingToolCall = {
  toolName: string;
  target: SessionActivityTarget | undefined;
  startedAt: number;
  timer?: unknown;
};

/**
 * Emits best-effort, content-free tool activity. Targets outside configured
 * virtual roots are redacted; this is observability, not access control.
 */
export function subscribeToSessionActivity(
  session: SessionActivitySource,
  options: SessionActivityOptions,
  runtime: SessionActivityRuntime = {},
): () => void {
  if (typeof options.sink !== "function") {
    throw new Error("activity sink must be a function");
  }
  const roots = normalizeRoots(options.roots);
  const runningThresholdMs = options.runningThresholdMs ?? DEFAULT_RUNNING_THRESHOLD_MS;
  if (!Number.isFinite(runningThresholdMs) || runningThresholdMs < 0) {
    throw new Error("activity runningThresholdMs must be a non-negative number");
  }
  const now = runtime.now ?? (() => performance.now());
  const schedule = runtime.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const cancel =
    runtime.cancel ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const pendingCalls = new Map<string, PendingToolCall>();
  let disposed = false;

  const emit = (event: SessionActivityEvent): void => {
    try {
      options.sink(event);
    } catch {
      // Optional observability must not affect the model turn.
    }
  };

  const handle = (event: unknown): void => {
    if (disposed || !isRecord(event)) return;
    if (isToolStart(event)) {
      const previous = pendingCalls.get(event.toolCallId);
      if (previous?.timer !== undefined) cancel(previous.timer);
      const pending: PendingToolCall = {
        toolName: safeToolName(event.toolName),
        target: activityTarget(event.args, roots),
        startedAt: now(),
      };
      pendingCalls.set(event.toolCallId, pending);
      pending.timer = schedule(() => {
        if (disposed || pendingCalls.get(event.toolCallId) !== pending) return;
        emit({
          type: "tool",
          toolName: pending.toolName,
          ...(pending.target ? { target: pending.target } : {}),
          status: "running",
        });
      }, runningThresholdMs);
      return;
    }

    if (!isToolEnd(event)) return;
    const pending = pendingCalls.get(event.toolCallId);
    const status = event.isError ? "error" : "ok";
    if (!pending) {
      emit({
        type: "tool",
        toolName: safeToolName(event.toolName),
        status,
      });
      return;
    }
    pendingCalls.delete(event.toolCallId);
    if (pending.timer !== undefined) cancel(pending.timer);
    const durationMs = elapsedMilliseconds(now(), pending.startedAt);
    emit({
      type: "tool",
      toolName: pending.toolName,
      ...(pending.target ? { target: pending.target } : {}),
      status,
      ...(durationMs === undefined ? {} : { durationMs }),
    });
  };

  const unsubscribe = session.subscribe(handle);
  return () => {
    if (disposed) return;
    disposed = true;
    try {
      unsubscribe();
    } finally {
      for (const pending of pendingCalls.values()) {
        if (pending.timer !== undefined) cancel(pending.timer);
      }
      pendingCalls.clear();
    }
  };
}

function normalizeRoots(roots: readonly SessionActivityRoot[]): NormalizedRoot[] {
  const virtualPaths = new Set<string>();
  return roots.map((root, index) => {
    const virtualPath = posix.normalize(root.virtualPath.replaceAll("\\", "/")).replace(/\/$/, "");
    if (!/^[a-z][a-z0-9-]*$/.test(virtualPath)) {
      throw new Error(
        `activity roots[${index}].virtualPath must be one lowercase top-level path segment`,
      );
    }
    if (!isAbsolute(root.directory)) {
      throw new Error(`activity roots[${index}].directory must be absolute`);
    }
    if (virtualPaths.has(virtualPath)) {
      throw new Error("activity root virtualPath values must be unique");
    }
    virtualPaths.add(virtualPath);
    return { virtualPath, directory: resolve(root.directory) };
  });
}

function activityTarget(
  args: unknown,
  roots: readonly NormalizedRoot[],
): SessionActivityTarget | undefined {
  const path = toolPath(args);
  if (!path) return undefined;
  const virtualPath = normalizedVirtualPath(path, roots) ?? virtualPathForAbsolutePath(path, roots);
  return virtualPath && isSafeVirtualPath(virtualPath)
    ? { kind: "virtual", path: virtualPath }
    : { kind: "redacted" };
}

function normalizedVirtualPath(path: string, roots: readonly NormalizedRoot[]): string | undefined {
  const normalized = posix.normalize(path.replaceAll("\\", "/")).replace(/^\.\//, "");
  return roots.some(
    (root) => normalized === root.virtualPath || normalized.startsWith(`${root.virtualPath}/`),
  )
    ? normalized
    : undefined;
}

function virtualPathForAbsolutePath(
  path: string,
  roots: readonly NormalizedRoot[],
): string | undefined {
  if (!isAbsolute(path)) return undefined;
  const absolutePath = resolve(path);
  for (const root of roots) {
    if (!isWithin(absolutePath, root.directory)) continue;
    const suffix = relative(root.directory, absolutePath).replaceAll("\\", "/");
    return suffix ? `${root.virtualPath}/${suffix}` : root.virtualPath;
  }
  return undefined;
}

function toolPath(args: unknown): string | undefined {
  if (!isRecord(args)) return undefined;
  if (typeof args.path === "string") return args.path;
  return typeof args.cwd === "string" ? args.cwd : undefined;
}

function safeToolName(name: string): string {
  return /^[A-Za-z0-9._-]+$/.test(name) ? name : "<unsafe-tool>";
}

function isSafeVirtualPath(path: string): boolean {
  return /^[A-Za-z0-9._/-]+$/.test(path);
}

function elapsedMilliseconds(completedAt: number, startedAt: number): number | undefined {
  const elapsed = completedAt - startedAt;
  return Number.isFinite(elapsed) ? Math.max(0, elapsed) : undefined;
}

function isWithin(path: string, root: string): boolean {
  const fromRoot = relative(resolve(root), resolve(path));
  return fromRoot === "" || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot));
}

function isToolStart(event: Record<string, unknown>): event is Record<string, unknown> & {
  type: "tool_execution_start";
  toolCallId: string;
  toolName: string;
  args: unknown;
} {
  return (
    event.type === "tool_execution_start" &&
    typeof event.toolCallId === "string" &&
    typeof event.toolName === "string"
  );
}

function isToolEnd(event: Record<string, unknown>): event is Record<string, unknown> & {
  type: "tool_execution_end";
  toolCallId: string;
  toolName: string;
  isError: boolean;
} {
  return (
    event.type === "tool_execution_end" &&
    typeof event.toolCallId === "string" &&
    typeof event.toolName === "string" &&
    typeof event.isError === "boolean"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
