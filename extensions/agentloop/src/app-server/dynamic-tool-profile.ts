import type { AgentLoopPluginConfig } from "./config.js";

/**
 * Agent-loop SDK built-in tool names that overlap with OpenClaw equivalents.
 * These are excluded by default so the SDK uses its own implementation.
 * Only tools NOT in this set (OpenClaw-unique tools) get injected.
 */
export const AGENTLOOP_INTERNAL_TOOL_NAMES: ReadonlySet<string> = new Set([
  "read",
  "write",
  "edit",
  "bash",
  "glob",
  "grep",
  "web_search",
  "web_fetch",
  "todo_write",
  "task",
  "notebook_edit",
]);

export const DEFAULT_TOOL_EXCLUDES: readonly string[] = [...AGENTLOOP_INTERNAL_TOOL_NAMES] as const;

export function applyDynamicToolProfile<T extends { name: string }>(
  tools: T[],
  config: Pick<AgentLoopPluginConfig, "toolTimeoutMs">,
): T[] {
  const excludes = new Set(DEFAULT_TOOL_EXCLUDES.map((name) => name.toLowerCase()));

  return tools.filter((tool) => !excludes.has(tool.name.toLowerCase()));
}
