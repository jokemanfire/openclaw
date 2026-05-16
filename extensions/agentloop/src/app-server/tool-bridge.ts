import { createOpenClawCodingTools } from "openclaw/plugin-sdk/agent-harness";
import { embeddedAgentLog, supportsModelTools, AgentHarnessAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { AnyAgentTool } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { UnifiedTool } from "@zte/agentloop-sdk/sdk";
import { applyDynamicToolProfile } from "./dynamic-tool-profile.js";

export async function buildToolDefinitions(
  params: AgentHarnessAttemptParams & { pluginConfig?: Record<string, unknown>; },
): Promise<UnifiedTool[]> {
  const p = params as Record<string, unknown>;

  if (p.disableTools || !supportsModelTools(p.model)) {
    return [];
  }

  const allTools = createOpenClawCodingTools({
    agentId: (p.agentId as string) ?? "",
    sessionKey: (p.sessionKey as string) ?? (p.sessionId as string) ?? "",
    sessionId: (p.sessionId as string) ?? "",
    runId: (p.runId as string) ?? "",
    config: p.config,
    agentDir: (p.agentDir as string) ?? (p.workspaceDir as string) ?? "",
    workspaceDir: (p.workspaceDir as string) ?? "",
    modelProvider: p.provider as string,
    modelId: p.modelId as string,
    modelApi:
      typeof (p.model as Record<string, unknown>)?.api === "string"
        ? ((p.model as Record<string, unknown>).api as string)
        : undefined,
    modelContextWindowTokens:
      typeof (p.model as Record<string, unknown>)?.contextWindow === "number"
        ? ((p.model as Record<string, unknown>).contextWindow as number)
        : undefined,
    messageProvider: (p.messageChannel as string) ?? (p.messageProvider as string),
    messageTo: p.messageTo as string,
    messageThreadId: p.messageThreadId as string | number,
    groupId: p.groupId as string | null,
    groupChannel: p.groupChannel as string | null,
    groupSpace: p.groupSpace as string | null,
    spawnedBy: p.spawnedBy as string | null,
    senderId: p.senderId as string | null,
    senderName: p.senderName as string | null,
    senderUsername: p.senderUsername as string | null,
    senderE164: p.senderE164 as string | null,
    senderIsOwner: p.senderIsOwner as boolean,
    currentChannelId: p.currentChannelId as string,
    currentThreadTs: p.currentThreadTs as string,
    currentMessageId: p.currentMessageId as string | number,
    abortSignal: p.signal as AbortSignal,
    exec: p.execOverrides,
    sandbox: p.sandbox,
    agentAccountId: p.agentAccountId as string,
    allowGatewaySubagentBinding: p.allowGatewaySubagentBinding as boolean,
    replyToMode: p.replyToMode as string,
    hasRepliedRef: p.hasRepliedRef,
    requireExplicitMessageTarget: p.requireExplicitMessageTarget as boolean,
    disableMessageTool: p.disableMessageTool as boolean,
  });

  const profiled = applyDynamicToolProfile(allTools as unknown as AnyAgentTool[], {
    toolTimeoutMs: 30000,
  });

  embeddedAgentLog.debug(
    `[agentloop] built tools total=${allTools.length} profiled=${profiled.length}`,
  );

  return profiled.map(toUnifiedTool);
}

function toUnifiedTool(tool: AnyAgentTool): UnifiedTool {
  return {
    name: tool.name,
    description: tool.description,
    parameters: (tool.parameters as Record<string, unknown>) ?? {},
    execute: async (args: Record<string, unknown>) => {
      console.log('[tool-bridge] calling tool:', tool.name, 'args:', JSON.stringify(args));
      const callId = `call_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const signal = new AbortController().signal;
      const preparedArgs = tool.prepareArguments?.(args) ?? (args === null || args === undefined ? {} : args);
      const result = await tool.execute(callId, preparedArgs, signal);
      console.log('[tool-bridge] result:', JSON.stringify(result));
      return result;
    },
  } as UnifiedTool;
}
