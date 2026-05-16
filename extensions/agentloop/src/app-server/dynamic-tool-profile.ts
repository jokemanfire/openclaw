import type { AgentLoopPluginConfig } from "./config.js";

export const DEFAULT_TOOL_EXCLUDES: readonly string[] = [
] as const;

export function applyDynamicToolProfile<T extends { name: string }>(
  tools: T[],
  config: Pick<AgentLoopPluginConfig, "toolTimeoutMs">,
): T[] {
  const excludes = new Set<string>();

  return excludes.size === 0
    ? tools
    : tools.filter((tool) => !excludes.has(tool.name));
}
