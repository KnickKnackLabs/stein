import { describe, expect, test } from "bun:test";
import {
  type SessionActivityEvent,
  subscribeToSessionActivity,
} from "../../src/session/activity-events.ts";

const roots = [
  { virtualPath: "notes", directory: "/private/product/notes" },
  {
    virtualPath: "conversation",
    directory: "/private/product/conversations/abc",
  },
] as const;

class FakeActivitySource {
  readonly #listeners = new Set<(event: unknown) => void>();

  subscribe(listener: (event: unknown) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  emit(event: unknown): void {
    for (const listener of this.#listeners) listener(event);
  }

  get listenerCount(): number {
    return this.#listeners.size;
  }
}

class ManualClock {
  time = 0;
  nextId = 1;
  timers = new Map<number, { at: number; callback: () => void }>();

  now = (): number => this.time;
  schedule = (callback: () => void, delayMs: number): number => {
    const id = this.nextId++;
    this.timers.set(id, { at: this.time + delayMs, callback });
    return id;
  };
  cancel = (handle: unknown): void => {
    this.timers.delete(handle as number);
  };
  advance(milliseconds: number): void {
    const target = this.time + milliseconds;
    while (true) {
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort(([firstId, first], [secondId, second]) =>
          first.at === second.at ? firstId - secondId : first.at - second.at,
        )[0];
      if (!next) break;
      const [id, timer] = next;
      this.timers.delete(id);
      this.time = timer.at;
      timer.callback();
    }
    this.time = target;
  }
}

function startEvent(toolCallId: string, toolName: string, args: Record<string, unknown>): unknown {
  return { type: "tool_execution_start", toolCallId, toolName, args };
}

function endEvent(
  toolCallId: string,
  toolName: string,
  isError = false,
  result: unknown = { content: [] },
): unknown {
  return {
    type: "tool_execution_end",
    toolCallId,
    toolName,
    result,
    isError,
  };
}

function fixture() {
  const source = new FakeActivitySource();
  const clock = new ManualClock();
  const events: SessionActivityEvent[] = [];
  const dispose = subscribeToSessionActivity(
    source,
    { roots, sink: (event) => events.push(event) },
    {
      now: clock.now,
      schedule: clock.schedule,
      cancel: clock.cancel,
    },
  );
  return { source, clock, events, dispose };
}

describe("session activity events", () => {
  test("emits one structured completion with a safe virtual target", () => {
    const { source, clock, events } = fixture();
    source.emit(
      startEvent("quick", "read", {
        path: "notes/observations.md",
        secret: "must-not-appear",
      }),
    );
    clock.advance(42);
    source.emit(
      endEvent("quick", "read", false, {
        content: [{ type: "text", text: "private result" }],
      }),
    );

    expect(events).toEqual([
      {
        type: "tool",
        toolName: "read",
        target: { kind: "virtual", path: "notes/observations.md" },
        status: "ok",
        durationMs: 42,
      },
    ]);
    expect(JSON.stringify(events)).not.toContain("must-not-appear");
    expect(JSON.stringify(events)).not.toContain("private result");
  });

  test("emits delayed running and correlated completion events", () => {
    const { source, clock, events } = fixture();
    source.emit(
      startEvent("slow", "write", {
        path: "conversation/result.md",
      }),
    );
    clock.advance(999);
    expect(events).toEqual([]);
    clock.advance(1);
    expect(events).toEqual([
      {
        type: "tool",
        toolName: "write",
        target: { kind: "virtual", path: "conversation/result.md" },
        status: "running",
      },
    ]);
    clock.advance(4_200);
    source.emit(endEvent("slow", "write", true));

    expect(events[1]).toEqual({
      type: "tool",
      toolName: "write",
      target: { kind: "virtual", path: "conversation/result.md" },
      status: "error",
      durationMs: 5_200,
    });
  });

  test("correlates parallel calls that complete out of order", () => {
    const { source, clock, events } = fixture();
    source.emit(startEvent("first", "read", { path: "notes/first.md" }));
    clock.advance(100);
    source.emit(
      startEvent("second", "edit", {
        path: "conversation/result.md",
      }),
    );
    clock.advance(150);
    source.emit(endEvent("first", "read", true));
    clock.advance(50);
    source.emit(endEvent("second", "edit"));

    expect(events).toEqual([
      {
        type: "tool",
        toolName: "read",
        target: { kind: "virtual", path: "notes/first.md" },
        status: "error",
        durationMs: 250,
      },
      {
        type: "tool",
        toolName: "edit",
        target: { kind: "virtual", path: "conversation/result.md" },
        status: "ok",
        durationMs: 200,
      },
    ]);
  });

  test("virtualizes scoped absolute targets and redacts every other path", () => {
    const { source, clock, events } = fixture();
    source.emit(
      startEvent("inside", "read", {
        path: "/private/product/notes/guidance.md",
      }),
    );
    clock.advance(5);
    source.emit(endEvent("inside", "read"));
    source.emit(
      startEvent("outside", "read", {
        path: "/private/other-client/note.md",
      }),
    );
    clock.advance(7);
    source.emit(endEvent("outside", "read"));
    source.emit(
      startEvent("unsafe", "read", {
        path: "notes/safe.md\nforged status=ok",
      }),
    );
    clock.advance(1);
    source.emit(endEvent("unsafe", "read"));

    expect(events.map((event) => event.target)).toEqual([
      { kind: "virtual", path: "notes/guidance.md" },
      { kind: "redacted" },
      { kind: "redacted" },
    ]);
    expect(JSON.stringify(events)).not.toContain("other-client");
    expect(JSON.stringify(events)).not.toContain("forged");
  });

  test("sanitizes tool names and tolerates unmatched completion events", () => {
    const { source, events } = fixture();
    source.emit(endEvent("missing", "read\nprivate", true));

    expect(events).toEqual([
      {
        type: "tool",
        toolName: "<unsafe-tool>",
        status: "error",
      },
    ]);
  });

  test("sink failures never affect the session and disposal cancels timers", () => {
    const source = new FakeActivitySource();
    const clock = new ManualClock();
    const dispose = subscribeToSessionActivity(
      source,
      {
        roots,
        sink() {
          throw new Error("fictional display failure");
        },
      },
      {
        now: clock.now,
        schedule: clock.schedule,
        cancel: clock.cancel,
      },
    );

    expect(() => {
      source.emit(startEvent("safe", "read", { path: "notes/check.md" }));
      clock.advance(1_000);
      source.emit(endEvent("safe", "read"));
    }).not.toThrow();
    source.emit(startEvent("disposed", "read", { path: "notes/check.md" }));
    dispose();
    dispose();
    clock.advance(2_000);
    expect(source.listenerCount).toBe(0);
    expect(clock.timers.size).toBe(0);
  });

  test("rejects unsafe activity configuration", () => {
    const source = new FakeActivitySource();
    const sink = () => {};
    expect(() =>
      subscribeToSessionActivity(source, {
        roots: [{ virtualPath: "nested/path", directory: "/private/root" }],
        sink,
      }),
    ).toThrow("virtualPath");
    expect(() =>
      subscribeToSessionActivity(source, {
        roots: [{ virtualPath: "notes", directory: "relative" }],
        sink,
      }),
    ).toThrow("directory must be absolute");
    expect(() =>
      subscribeToSessionActivity(source, {
        roots: [
          { virtualPath: "notes", directory: "/private/one" },
          { virtualPath: "notes", directory: "/private/two" },
        ],
        sink,
      }),
    ).toThrow("must be unique");
    expect(() =>
      subscribeToSessionActivity(source, {
        roots: [],
        sink,
        runningThresholdMs: -1,
      }),
    ).toThrow("non-negative");
    expect(source.listenerCount).toBe(0);
  });
});
