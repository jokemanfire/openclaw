import type { SDKMessage, PromptInput, LoopResult, AppLoopConfig } from "@zte/agentloop-sdk/sdk";
import {
  embeddedAgentLog,
  emitAgentEvent,
  runAgentHarnessLlmInputHook,
  runAgentHarnessLlmOutputHook,
  runAgentHarnessAgentEndHook,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import type {
  AgentHarnessV2CleanupParams,
  AgentHarnessAttemptParams,
  AgentHarnessAttemptResult,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { resolveAgentLoopConfig, type AgentLoopLoopType } from "./config.js";
import type { LoopRegistry } from "./loop-registry.js";
import { readAgentLoopBinding, writeAgentLoopBinding } from "./session-binding.js";
import { buildToolDefinitions } from "./tool-bridge.js";

export type AgentLoopPreparedRun = {
  harnessId: string;
  label: string;
  pluginId?: string;
  params: AgentHarnessAttemptParams;
  lifecycleState: "prepared";
  resolvedConfig: ReturnType<typeof resolveAgentLoopConfig>;
  appName: string;
  isFirstRequest: boolean;
  agentId?: string;
  loopType?: AgentLoopLoopType;
};

export type AgentLoopSession = {
  harnessId: string;
  label: string;
  pluginId?: string;
  params: AgentHarnessAttemptParams;
  lifecycleState: "started";
  resolvedConfig: ReturnType<typeof resolveAgentLoopConfig>;
  appName: string;
  bindingWritten: boolean;
  signal: AbortSignal;
  agentId?: string;
  loopType?: AgentLoopLoopType;
};

type PrepareOptions = {
  loopRegistry: LoopRegistry;
  pluginConfig?: unknown;
};

type SendOptions = {
  loopRegistry?: LoopRegistry;
  pluginConfig?: unknown;
};

export async function prepareAgentLoopAttempt(
  params: AgentHarnessAttemptParams,
  options: PrepareOptions,
): Promise<AgentLoopPreparedRun> {
  const resolvedConfig = resolveAgentLoopConfig({ pluginConfig: options.pluginConfig });
  const appName = resolveAppName(params, options);

  const existingBinding = params.sessionFile
    ? await readAgentLoopBinding(params.sessionFile)
    : undefined;

  const appManifest = options.loopRegistry.getApp(appName);
  const agentId = parseAgentId(params) ?? appManifest?.loops[0]?.id;
  const loopConfig = appManifest?.loops.find((l) => l.id === agentId);
  const loopType = loopConfig?.type as AgentLoopLoopType | undefined;

  embeddedAgentLog.debug(
    `[agentloop] prepare complete appName=${appName} agentId=${agentId} loopType=${loopType} isFirstRequest=${!existingBinding}`,
  );

  return {
    harnessId: "agentloop",
    label: "AgentLoop harness",
    pluginId: "agentloop",
    params,
    lifecycleState: "prepared",
    resolvedConfig,
    appName,
    isFirstRequest: !existingBinding,
    agentId,
    loopType,
  };
}

export async function startAgentLoopAttempt(
  prepared: AgentLoopPreparedRun,
): Promise<AgentLoopSession> {
  const loopId = prepared.agentId ?? "supervisor";
  const loopType = prepared.loopType ?? "supervisor";

  if (prepared.params.sessionFile) {
    await writeAgentLoopBinding(prepared.params.sessionFile, {
      appName: prepared.appName,
      loopId,
      loopType: loopType as AgentLoopLoopType,
      model: prepared.params.modelId,
      modelProvider: prepared.params.provider,
    });
  }

  return {
    harnessId: prepared.harnessId,
    label: prepared.label,
    pluginId: prepared.pluginId,
    params: prepared.params,
    lifecycleState: "started",
    resolvedConfig: prepared.resolvedConfig,
    appName: prepared.appName,
    bindingWritten: true,
    signal: prepared.params.signal ?? new AbortController().signal,
    agentId: prepared.agentId,
    loopType: prepared.loopType,
  };
}

export async function sendAgentLoopAttempt(
  session: AgentLoopSession,
  options: SendOptions,
): Promise<AgentHarnessAttemptResult> {
  const { params, appName } = session;

  const appManifest = options.loopRegistry?.getApp(appName);
  if (!appManifest) {
    const availableApps = options.loopRegistry?.listApps() ?? [];
    embeddedAgentLog.warn(
      `[agentloop] app manifest not found appName=${appName} availableApps=${JSON.stringify(availableApps)}`,
    );
    return {
      assistantTexts: [
        `[agentloop] no app manifest available for "${appName}". Available apps: [${availableApps.join(", ") || "none"}].`,
      ],
      finishReason: "stop",
      itemLifecycle: { started: 0, completed: 0, skipped: 0, aborted: 0 },
    };
  }

  const agentId = session.agentId ?? parseAgentId(params) ?? appManifest.loops[0]?.id;
  const appConfig: AppLoopConfig = {
    app_name: appManifest.appName,
    loop_mode: appManifest.loops,
  };

  const { createLoopById } = await import("@zte/agentloop-sdk/sdk");
  const loop = createLoopById(agentId, appConfig);
  embeddedAgentLog.info(`[agentloop] loop.run config=${JSON.stringify(appConfig)}`);

  const promptInput = buildPromptInput(params);
  const loopOptions = await buildLoopOptions(session, agentId, appManifest);
  embeddedAgentLog.debug(`[agentloop] loop.loopOptions=${JSON.stringify(loopOptions)}`);

  const attemptStartedAt = Date.now();
  const hookCtx = {
    runId: params.runId,
    agentId,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    workspaceDir: params.workspaceDir,
  };

  try {
    runAgentHarnessLlmInputHook({
      event: {
        runId: params.runId,
        sessionId: params.sessionId,
        provider: params.provider,
        model: params.modelId,
        prompt: params.prompt,
        historyMessages: [],
        imagesCount: params.images?.length ?? 0,
      },
      ctx: hookCtx,
    });
  } catch (error) {
    embeddedAgentLog.warn(`[agentloop] runAgentHarnessLlmInputHook failed error=${String(error)}`);
  }

  let messages: SDKMessage[] = [];
  let assistantTexts: string[] = [];
  let emittedSnapshot = "";
  let lastChunk = "";
  let success = true;

  try {
    embeddedAgentLog.info(
      `[agentloop] loop.run starting agentId=${agentId} model=${params.modelId}`,
    );
    const result: LoopResult = loop.run(promptInput, loopOptions);
    for await (const msg of result) {
      messages.push(msg);
      embeddedAgentLog.debug(
        `[agentloop] raw msg type=${msg.type} keys=${Object.keys(msg).join(",")}`,
      );

      if (msg.type !== "assistant") continue;

      const extractedText = extractAssistantText(msg);
      if (!extractedText) continue;

      if (extractedText === lastChunk) continue;

      assistantTexts.push(extractedText);

      const delta = emittedSnapshot.length > 0 ? `\n\n${extractedText}` : extractedText;
      if (!delta.trim()) continue;

      emittedSnapshot = emittedSnapshot + delta;
      lastChunk = extractedText;
      const data: Record<string, unknown> = {
        text: emittedSnapshot,
        delta,
        phase: "text",
      };

      try {
        emitAgentEvent({
          runId: params.runId,
          stream: "assistant",
          data,
        });
        params.onAgentEvent?.({ stream: "assistant", data });
        embeddedAgentLog.info(`[agentloop] emit data=${JSON.stringify(data)}`);
      } catch (pushErr) {
        embeddedAgentLog.warn(`[agentloop] push msg error=${String(pushErr)}`);
      }
    }
  } catch (error) {
    success = false;
    embeddedAgentLog.warn(`[agentloop] loop.run failed agentId=${agentId} error=${String(error)}`);
  }

  try {
    runAgentHarnessLlmOutputHook({
      event: {
        runId: params.runId,
        sessionId: params.sessionId,
        provider: params.provider,
        model: params.modelId,
        assistantTexts,
      },
      ctx: hookCtx,
    });
  } catch (error) {
    embeddedAgentLog.warn(`[agentloop] runAgentHarnessLlmOutputHook failed error=${String(error)}`);
  }

  try {
    runAgentHarnessAgentEndHook({
      event: {
        messages: messages as Parameters<
          typeof runAgentHarnessAgentEndHook
        >[0]["event"]["messages"],
        success,
        durationMs: Date.now() - attemptStartedAt,
      },
      ctx: hookCtx as Parameters<typeof runAgentHarnessAgentEndHook>[0]["ctx"],
    });
  } catch (error) {
    embeddedAgentLog.warn(`[agentloop] runAgentHarnessAgentEndHook failed error=${String(error)}`);
  }

  return {
    assistantTexts: assistantTexts.length > 0 ? assistantTexts : ["agentloop execution completed."],
    finishReason: success ? "stop" : "error",
    itemLifecycle: { started: 0, completed: messages.length, skipped: 0, aborted: 0 },
  };
}

export async function resolveAgentLoopOutcome(
  _session: AgentLoopSession,
  result: AgentHarnessAttemptResult,
): Promise<AgentHarnessAttemptResult> {
  return result;
}

export async function cleanupAgentLoopAttempt(
  _params: AgentHarnessV2CleanupParams,
): Promise<void> {}

function extractAssistantText(msg: SDKMessage): string {
  if (msg.type !== "assistant") return "";

  if (typeof msg.content === "string" && msg.content) {
    return msg.content;
  }

  const messageObj = (msg as Record<string, unknown>).message;
  if (messageObj && typeof messageObj === "object") {
    const contentBlocks = (messageObj as Record<string, unknown>).content;
    if (Array.isArray(contentBlocks)) {
      const texts: string[] = [];
      for (const block of contentBlocks) {
        if (
          block &&
          typeof block === "object" &&
          (block as Record<string, unknown>).type === "text"
        ) {
          const text = (block as Record<string, unknown>).text;
          if (typeof text === "string") {
            texts.push(text);
          }
        }
      }
      if (texts.length > 0) {
        return texts.join("");
      }
    }
  }

  const text = (msg as Record<string, unknown>).text;
  if (typeof text === "string") {
    return text;
  }

  return "";
}

function resolveAppName(params: AgentHarnessAttemptParams, options: PrepareOptions): string {
  const agentId = parseAgentIdFromSessionKey(params.sessionKey);
  if (agentId) {
    const entry = options.loopRegistry.resolveAgentId(agentId);
    if (entry) return entry.appName;
  }
  const apps = options.loopRegistry.listApps();
  return apps.length > 0 ? apps[0] : "default";
}

function parseAgentIdFromSessionKey(sessionKey?: string): string | undefined {
  if (!sessionKey) return undefined;
  const parts = sessionKey.split(":");
  if (parts.length >= 2 && parts[0] === "agent" && parts[1]?.trim()) {
    return parts[1].trim();
  }
  return undefined;
}

function parseAgentId(params: AgentHarnessAttemptParams): string | undefined {
  return parseAgentIdFromSessionKey(params.sessionKey);
}

function buildPromptInput(params: AgentHarnessAttemptParams): PromptInput {
  if (params.images?.length) {
    return {
      type: "with_attachment",
      text: params.prompt,
      attachments: params.images.map((img) => ({
        type: "screenshot",
        screenshot: {
          base64: img.data,
          width: 0,
          height: 0,
        },
      })),
    };
  }
  return params.prompt;
}

async function buildLoopOptions(
  session: AgentLoopSession,
  agentId: string,
  appManifest: import("./loop-registry.js").AppManifest,
): Promise<Record<string, unknown>> {
  const { params } = session;

  const tools = await buildToolDefinitions({
    ...params,
    agentId,
  } as Parameters<typeof buildToolDefinitions>[0]);

  const appSystemPrompt = appManifest?.loops.find((l) => l.id === agentId)?.systemPrompt;
  const systemPrompt = buildAgentSystemPrompt(
    appSystemPrompt,
    params.skillsSnapshot?.prompt,
    params.extraSystemPrompt,
  );

  return {
    tools,
    ...(params.toolsAllow ? { allowedTools: params.toolsAllow } : {}),
    ...(systemPrompt ? { systemPrompt } : {}),
    permissionMode: "default" as const,
    sessionId: `sessionId:${params.sessionId ?? ""}:sessionKey:${params.sessionKey ?? ""}`,
    model: params.modelId,
    ...(params.model?.api ? { api: String(params.model.api) } : {}),
    ...(resolveProviderUrl(params)
      ? { url: resolveProviderUrl(params) }
      : (params.model as any)?.baseUrl
        ? { url: (params.model as any).baseUrl }
        : {}),
    ...(params.resolvedApiKey
      ? { authToken: params.resolvedApiKey }
      : resolveModelProviderApiKey(params)
        ? { authToken: resolveModelProviderApiKey(params) }
        : {}),
    maxTurns: session.resolvedConfig.loop.maxTurns,
    cwd: params.workspaceDir,
    workspace: params.workspaceDir,
    ...(params.images?.length ? { includePartialMessages: true } : {}),
    ...(params.thinkLevel ? { effort: params.thinkLevel } : {}),
    timeout: params.timeoutMs,
    ...(params.signal ? { signal: params.signal } : {}),
  };
}

function buildAgentSystemPrompt(
  appConfig?: { apply_mode?: string; content?: string },
  skillsPrompt?: string,
  extraPrompt?: string,
): string | undefined {
  const content = appConfig?.content?.trim();
  if (!content) {
    return (
      [skillsPrompt, extraPrompt]
        .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
        .join("\n\n") || undefined
    );
  }

  if (appConfig?.apply_mode === "override") {
    return content;
  }

  return (
    [skillsPrompt, extraPrompt, content]
      .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
      .join("\n\n") || undefined
  );
}

function resolveProviderUrl(params: AgentHarnessAttemptParams): string | undefined {
  try {
    const entries = (params.config as Record<string, unknown>)?.plugins?.entries as
      | Record<string, { config?: Record<string, unknown> }>
      | undefined;
    return entries?.[params.provider]?.config?.baseUrl as string | undefined;
  } catch (error) {
    embeddedAgentLog.debug(`[agentloop] resolveProviderUrl fallback error=${String(error)}`);
    return undefined;
  }
}

function resolveModelProviderApiKey(params: AgentHarnessAttemptParams): string | undefined {
  // 优先级：resolvedApiKey > model.headers.Authorization > config.models.providers[provider].apiKey
  if (params.resolvedApiKey) {
    return params.resolvedApiKey;
  }
  // 从 model.headers.Authorization 提取 Bearer token
  const authHeader =
    (params.model as any)?.headers?.Authorization || (params.model as any)?.headers?.authorization;
  if (typeof authHeader === "string") {
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (match) {
      return match[1];
    }
  }
  // 从 config.models.providers[provider].apiKey 读取
  try {
    const providers = (params.config as Record<string, unknown>)?.models?.providers as
      | Record<string, { apiKey?: string }>
      | undefined;
    const key = providers?.[params.provider]?.apiKey;
    if (key) {
      return key;
    }
  } catch (error) {
    embeddedAgentLog.debug(
      `[agentloop] resolveModelProviderApiKey fallback error=${String(error)}`,
    );
  }
  return undefined;
}
