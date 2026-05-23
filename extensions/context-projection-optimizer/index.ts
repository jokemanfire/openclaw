import {
  buildMemorySystemPromptAddition,
  definePluginEntry,
  delegateCompactionToRuntime,
  type OpenClawPluginApi,
} from "openclaw/plugin-sdk/core";
import {
  estimateTextTokens,
  projectMessagesForContext,
  resolveProjectionProfileSelection,
} from "./src/projection.js";

type ContextEngineFactory = Parameters<OpenClawPluginApi["registerContextEngine"]>[1];
type ContextEngine = Awaited<ReturnType<ContextEngineFactory>>;

function createContextProjectionEngine(api: OpenClawPluginApi): ContextEngine {
  return {
    info: {
      id: "context-projection-optimizer",
      name: "Context Projection Optimizer",
      version: "0.1.0",
      // This engine only projects prompt context. Durable compaction stays on
      // OpenClaw's built-in Pi runtime path via delegateCompactionToRuntime().
      ownsCompaction: false,
      turnMaintenanceMode: "background",
    },
    async ingest() {
      return { ingested: false };
    },
    async assemble(params) {
      const profileSelection = resolveProjectionProfileSelection({
        pluginConfig: api.pluginConfig,
        prompt: params.prompt,
      });
      const projected = projectMessagesForContext(params.messages, profileSelection.config);
      if (projected.stats.projectedCount > 0) {
        api.logger.debug?.(
          `[context-projection-optimizer] profile=${profileSelection.effectiveProfile} projected ${projected.stats.projectedCount} tool results; chars ${projected.stats.originalChars}->${projected.stats.projectedChars}`,
        );
      }
      return {
        messages: projected.messages,
        estimatedTokens: estimateTextTokens(projected.messages),
        promptAuthority: "assembled",
        systemPromptAddition: buildMemorySystemPromptAddition({
          availableTools: params.availableTools ?? new Set(),
          citationsMode: params.citationsMode,
        }),
      };
    },
    async compact(params) {
      // Manual /compact and overflow recovery still use the stock runtime
      // compaction implementation instead of this projection-only engine.
      return await delegateCompactionToRuntime(params);
    },
    async afterTurn() {
      // Projection is intentionally non-persistent; the transcript remains the source of truth.
    },
    async maintain() {
      return {
        changed: false,
        bytesFreed: 0,
        rewrittenEntries: 0,
        reason: "projection-only",
      };
    },
  };
}

export default definePluginEntry({
  id: "context-projection-optimizer",
  name: "Context Projection Optimizer",
  description:
    "Projects old oversized tool results into compact context while delegating durable compaction to OpenClaw.",
  register(api: OpenClawPluginApi) {
    api.registerContextEngine("context-projection-optimizer", () =>
      createContextProjectionEngine(api),
    );
  },
});
