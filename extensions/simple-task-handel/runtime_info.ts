import os from "node:os";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

interface AgentHookCtx {
  agentId?: string;
  modelProviderId?: string;
  modelId?: string;
  channelId?: string;
}

let cachedRuntimeLine: string | undefined;

export function buildRuntimeInfo(
  api: OpenClawPluginApi,
  ctx: AgentHookCtx,
  targetAgentId: string,
): string {
  if (cachedRuntimeLine !== undefined) {
    return cachedRuntimeLine;
  }
  const agentConfig = api.config.agents?.list?.find((a) => a.id === targetAgentId);
  const agentModel = agentConfig?.model;
  const defaultModel = typeof agentModel === "string" ? agentModel : (agentModel?.primary ?? "");
  const thinking = agentConfig?.thinkingDefault ?? "off";

  const host = os.hostname();
  const osLabel = `${os.type()} ${os.release()}`;
  const arch = os.arch();
  const nodeVersion = process.version;

  const modelLabel =
    ctx.modelProviderId && ctx.modelId ? `${ctx.modelProviderId}/${ctx.modelId}` : "";

  const shell = detectShell();

  const columns: string[] = [
    ctx.agentId ? `agent=${ctx.agentId}` : "",
    host ? `host=${host}` : "",
    arch ? `os=${osLabel} (${arch})` : `os=${osLabel}`,
    nodeVersion ? `node=${nodeVersion}` : "",
    modelLabel ? `model=${modelLabel}` : "",
    defaultModel ? `default_model=${defaultModel}` : "",
    shell ? `shell=${shell}` : "",
    ctx.channelId ? `channel=${ctx.channelId}` : "",
    `thinking=${thinking}`,
  ].filter(Boolean);

  cachedRuntimeLine = `## Runtime\nRuntime: ${columns.join(" | ")}`;
  return cachedRuntimeLine;
}

export function clearRuntimeInfoCache(): void {
  cachedRuntimeLine = undefined;
}

function detectShell(): string | undefined {
  if (process.platform === "win32") {
    return process.env.POWERSHELL_DISTRIBUTION_CHANNEL ? "pwsh" : "powershell";
  }
  const envShell = process.env.SHELL?.trim();
  if (envShell) {
    const lastSlash = envShell.lastIndexOf("/");
    const name = lastSlash >= 0 ? envShell.slice(lastSlash + 1) : envShell;
    if (name && name !== "sh" && name !== "nologin") {
      return name;
    }
  }
  return "unknown";
}
