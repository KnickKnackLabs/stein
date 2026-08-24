import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

/** A Pi tool definition with generics erased for heterogeneous tool collections. */
// biome-ignore lint/suspicious/noExplicitAny: Upstream tool definitions are invariant across heterogeneous parameter, detail, and state types.
export type PiToolDefinition = ToolDefinition<any, any, any>;
