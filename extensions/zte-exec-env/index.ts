import {
  emptyPluginConfigSchema,
  type OpenClawPluginApi,
} from "openclaw/plugin-sdk";

const ENV_RUN_ID = "OPENCLAW_RUN_ID";
const ENV_TOOL_CALL_ID = "OPENCLAW_TOOL_CALL_ID";
const ENV_MESSAGE_PROVIDER = "OPENCLAW_MESSAGE_PROVIDER";

/** Latest message channel for a session, set in before_prompt_build (ctx.messageProvider / channelId). */
const messageProviderBySessionKey = new Map<string, string>();

function sessionCorrelationKey(ctx: { sessionKey?: string; sessionId?: string }): string | null {
  const sk = ctx.sessionKey?.trim();
  const sid = ctx.sessionId?.trim();
  if (!sk && !sid) {
    return null;
  }
  return `${sk ?? ""}\0${sid ?? ""}`;
}

function isExecLikeTool(toolName: string): boolean {
  const n = toolName.trim().toLowerCase();
  return n === "exec" || n === "bash";
}

/**
 * Merges OpenClaw run / tool-call identifiers (and optional message channel)
 * into the exec tool's `env` map so shell scripts can read them without model-supplied args.
 */
function mergeExecParamsWithEnv(
  params: Record<string, unknown>,
  runId: string,
  toolCallId: string,
  messageProvider?: string,
): Record<string, unknown> {
  const prev =
    params.env && typeof params.env === "object" && !Array.isArray(params.env)
      ? { ...(params.env as Record<string, string>) }
      : {};
  return {
    ...params,
    env: {
      ...prev,
      [ENV_RUN_ID]: runId,
      [ENV_TOOL_CALL_ID]: toolCallId,
      [ENV_MESSAGE_PROVIDER]: messageProvider
    },
  };
}

const plugin = {
  id: "exec-env",
  name: "Exec Environment",
  description:
    "Injects OPENCLAW_RUN_ID, OPENCLAW_TOOL_CALL_ID, and OPENCLAW_MESSAGE_PROVIDER into exec/bash subprocess environment (from run/tool-call hooks and before_prompt_build).",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    api.logger.info("exec-env: enabled (exec/bash environment variables)");
    api.on("before_prompt_build", async (event, ctx) => {
      const key = sessionCorrelationKey(ctx);
      if (!key) {
        return;
      }
      const mp = ctx.messageProvider?.trim() || ctx.channelId?.trim();
      if (mp) {
        messageProviderBySessionKey.set(key, mp);
      }
    });

    api.on("before_tool_call", async (event, ctx) => {
      if (!isExecLikeTool(event.toolName)) {
        return;
      }
      const runId = ctx.runId ?? event.runId ?? "";
      const toolCallId = ctx.toolCallId ?? event.toolCallId ?? "";
      const key = sessionCorrelationKey(ctx);
      const messageProvider =
        key !== null ? messageProviderBySessionKey.get(key) : undefined;
      return {
        params: mergeExecParamsWithEnv(
          event.params,
          runId,
          toolCallId,
          messageProvider,
        ),
      };
    });
  },
};

export default plugin;
