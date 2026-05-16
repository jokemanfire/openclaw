import {
  embeddedAgentLog,
  formatErrorMessage,
  isActiveHarnessContextEngine,
  runHarnessContextEngineMaintenance,
  type CompactEmbeddedPiSessionParams,
  type EmbeddedPiCompactResult,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { resolveAgentLoopConfig } from "./config.js";
import type { LoopRegistry } from "./loop-registry.js";
import { readAgentLoopBinding } from "./session-binding.js";

type ContextEngineCompactResult = Awaited<
  ReturnType<NonNullable<CompactEmbeddedPiSessionParams["contextEngine"]>["compact"]>
>;

const DEFAULT_COMPACTION_WAIT_TIMEOUT_MS = 5 * 60 * 1000;

export async function maybeCompactAgentLoopSession(
  params: CompactEmbeddedPiSessionParams,
  options: { loopRegistry?: LoopRegistry; pluginConfig?: unknown } = {},
): Promise<EmbeddedPiCompactResult | undefined> {
  const activeContextEngine = isActiveHarnessContextEngine(params.contextEngine)
    ? params.contextEngine
    : undefined;

  if (activeContextEngine?.info.ownsCompaction) {
    let primary: ContextEngineCompactResult | undefined;
    let primaryError: string | undefined;
    try {
      primary = await activeContextEngine.compact({
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        sessionFile: params.sessionFile,
        tokenBudget: params.contextTokenBudget,
        currentTokenCount: params.currentTokenCount,
        compactionTarget: params.trigger === "manual" ? "threshold" : "budget",
        customInstructions: params.customInstructions,
        force: params.trigger === "manual",
        runtimeContext: params.contextEngineRuntimeContext,
      });
    } catch (error) {
      primaryError = formatErrorMessage(error);
      embeddedAgentLog.warn(
        `context engine compaction failed; continuing loop-level compaction error=${primaryError}`,
      );
    }

    if (primary?.ok && primary.compacted) {
      try {
        await runHarnessContextEngineMaintenance(params.contextEngineRuntimeContext, "compaction");
      } catch (error) {
        embeddedAgentLog.warn(
          `context engine compaction maintenance failed; continuing error=${formatErrorMessage(error)}`,
        );
      }
      return {
        ok: true,
        compacted: true,
        details: primary.details,
      };
    }
  }

  const config = resolveAgentLoopConfig({ pluginConfig: options.pluginConfig });
  const binding = params.sessionFile ? await readAgentLoopBinding(params.sessionFile) : undefined;

  embeddedAgentLog.debug(
    `[agentloop] loop-level compaction sessionFile=${params.sessionFile} binding=${binding ? `appName=${binding.appName} loopId=${binding.loopId}` : "none"}`,
  );

  return {
    ok: true,
    compacted: false,
    reason: "loop-level compaction is not yet implemented (Phase 2+)",
  };
}
